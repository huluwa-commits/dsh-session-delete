/**
 * dsh-session-delete — 会话彻底删除（Host 侧）。
 *
 * 提供：
 *   GET  /session-delete/live            —— 当前仍 live 的会话（诊断）
 *   POST /session-delete/delete          —— body `{ sessionId }`，彻底删除
 *
 * 删除顺序（顺序本身是正确性的一部分）：
 *  1. 停掉该会话的全部活动（turn / job / subagent / schedule）—— 走官方
 *     archive 准入通道 `workspaceRegistry.archiveSession(id, {stopActivity:true})`；
 *  2. 若该会话仍 live：解除 agent 作用域（关闭写句柄、drain 缓冲、触发
 *     `session/disposed`），**必须早于删目录**，否则句柄 close 时的 drain 会把
 *     日志重新写回被删的目录，让会话“复活”；
 *  3. 撤销归档 / pin 标记，并从每个工作区的 sessionIds 里摘掉；
 *  4. 删除持久化日志目录 `~/.dsh/sessions/<projectKey>/<id>/`；
 *  5. 删除投影缓存（storageDomain 的 `session_projcache` 记录 + 文件兜底）；
 *  6. `ctx.emit('api-session/removed', id)` 让前端列表立即移除该行。
 *
 * 热会话（正在内存里运行的那个）走后台清理：先回响应再清理，避免删到自己
 * 当前这一轮时把 HTTP 响应一起掐掉。
 */
import { rm, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export const name = 'dsh-session-delete'

const ROUTE_PREFIX = '/session-delete'
/** 等热会话真正从 store 里消失的上限。 */
const DETACH_TIMEOUT_MS = 6000
/** 解除 agent 作用域的上限（超过就退化为“重启后消失”）。 */
const DISPOSE_TIMEOUT_MS = 6000

/** 编码一个会话 id 为目录名（与 session-persistence-jsonl 的 encodeSegment 一致）。 */
function encodeSegment(raw) {
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (const ch of raw) {
    if (ch !== '~' && /[A-Za-z0-9._-]/.test(ch)) out += ch
    else out += '~' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/** 会话 id 的两种历史拼写（带/不带 `session-` 前缀）。 */
function idSpellings(sessionId) {
  const names = new Set([sessionId, encodeSegment(sessionId)])
  if (sessionId.startsWith('session-')) names.add(sessionId.slice('session-'.length))
  else names.add(`session-${sessionId}`)
  return [...names]
}

/** 解析 DSH home（优先用持久化服务的 root，退回 DSH_HOME / ~/.dsh）。 */
function resolveHome(ctx) {
  const root = ctx.get('sessionPersistence')?.config?.root
  if (typeof root === 'string' && root !== '') return dirname(root)
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env !== '') return env
  return join(homedir(), '.dsh')
}

/** 读取请求体（JSON），失败返回 undefined。 */
async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

/** 写 JSON 响应。 */
function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(text)
}

/** 与 media-desk 相同：插件路由不继承鉴权，必须自己问 connection。 */
function requestRejection(ctx, req) {
  const connection = ctx.get('connection')
  if (typeof connection?.requestRejection !== 'function') return 403
  return connection.requestRejection({ headers: req.headers })
}

/** 尽力执行一个步骤，失败只记录不中断。 */
async function attempt(report, label, run) {
  try {
    const value = await run()
    report.steps.push({ step: label, ok: true, ...(value === undefined ? {} : { value }) })
    return value
  } catch (error) {
    report.steps.push({ step: label, ok: false, error: String(error?.message ?? error) })
    return undefined
  }
}

/** 带超时的 Promise；超时返回 undefined，不抛。 */
async function withTimeout(promise, ms) {
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** 找出该会话在持久化根下的所有目录（跨 projectKey 目录 + 两种拼写）。 */
async function findSessionDirs(home, sessionId) {
  const root = join(home, 'sessions')
  const names = idSpellings(sessionId)
  const found = []
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch {
    return found
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    for (const name of names) {
      const candidate = join(root, project.name, name)
      if (existsSync(candidate)) found.push(candidate)
    }
  }
  return found
}

/** 让一个仍 live 的会话从 store 里消失：解除其 agent 作用域，并等 store 清理。 */
async function detachLive(ctx, sessionId, report) {
  const agents = ctx.get('agents')
  const sessions = ctx.get('sessions')
  const agent = agents?.get?.(sessionId)
  if (agent === undefined && sessions?.get?.(sessionId) === undefined) return true

  if (agent !== undefined) {
    await attempt(report, 'cancel-turn', () => {
      if (agent.status === 'running') agent.cancel({ kind: 'user' })
    })
    // ReactLoopAgent 的作用域是本进程里唯一能触发完整 teardown 的入口：
    // teardown 会 cancel 当前 phase、等 idle、关闭持久化写句柄、detach session。
    const scope = agent.scope
    if (scope !== undefined && typeof scope.dispose === 'function') {
      await attempt(report, 'dispose-agent-scope', () =>
        withTimeout(Promise.resolve(scope.dispose()), DISPOSE_TIMEOUT_MS),
      )
    } else {
      report.steps.push({ step: 'dispose-agent-scope', ok: false, error: 'agent scope 不可用' })
    }
  }

  const deadline = Date.now() + DETACH_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (sessions?.get?.(sessionId) === undefined && agents?.get?.(sessionId) === undefined) {
      report.steps.push({ step: 'detached', ok: true })
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 60))
  }

  // 兜底：scope.dispose() 走的是 Cordis effect 链，某些情形下不会真正触发
  // agent-loop 的 teardown。registry 自己持有 entry，`detachEntered` 是它
  // 公开的移除入口（会发 `agent/disposed` / `session/disposed`，从而让持久化
  // 写句柄关闭并 drain），比等 effect 链更可靠。
  await attempt(report, 'force-detach', () => {
    const agentEntry = agents?.store?.get?.(sessionId)
    if (agentEntry !== undefined && typeof agents.detachEntered === 'function') {
      agents.detachEntered(agentEntry)
    }
    const sessionEntry = sessions?.store?.get?.(sessionId)
    if (sessionEntry !== undefined && typeof sessions.detachEntered === 'function') {
      sessions.detachEntered(sessionEntry)
    }
  })

  // 写句柄在 disposed 监听里异步关闭并 drain，给它一点时间落完，再删目录。
  const settleBy = Date.now() + 1500
  while (Date.now() < settleBy) {
    if (sessions?.get?.(sessionId) === undefined && agents?.get?.(sessionId) === undefined) break
    await new Promise((resolve) => setTimeout(resolve, 60))
  }

  const gone = sessions?.get?.(sessionId) === undefined && agents?.get?.(sessionId) === undefined
  report.steps.push(
    gone
      ? { step: 'detached', ok: true }
      : { step: 'detached', ok: false, error: '无法从内存中移除该会话' },
  )
  return gone
}

/** 真正执行清理，返回报告。 */
async function cleanup(ctx, sessionId, report) {
  const registry = ctx.get('workspaceRegistry')
  const sessions = ctx.get('sessions')
  const home = resolveHome(ctx)

  // 1) 停掉活动（官方准入通道）
  if (registry !== undefined) {
    await attempt(report, 'stop-activity', () => registry.archiveSession(sessionId, { stopActivity: true }))
  }

  // 2) 热会话：先解除作用域（关闭写句柄 + drain），再删目录
  const wasLive = sessions?.get?.(sessionId) !== undefined
  report.wasLive = wasLive
  if (wasLive) await detachLive(ctx, sessionId, report)

  // 3) 撤销归档 / pin / 工作区登记
  if (registry !== undefined) {
    await attempt(report, 'unarchive', () => registry.unarchiveSession(sessionId))
    await attempt(report, 'unpin', () => registry.unpinSession(sessionId))
    for (const workspace of registry.list()) {
      await attempt(report, `detach@${workspace.path ?? 'workspace'}`, () =>
        workspace.detachSession(sessionId),
      )
    }
  }

  // 4) 删持久化日志目录
  const dirs = new Set()
  const stat = await attempt(report, 'stat', () => ctx.get('sessionPersistence')?.stat(sessionId))
  if (stat?.location?.path) dirs.add(dirname(stat.location.path))
  for (const dir of await findSessionDirs(home, sessionId)) dirs.add(dir)
  for (const dir of dirs) {
    const removed = await attempt(report, `rm-dir ${dir}`, async () => {
      await rm(dir, { recursive: true, force: true })
      return !existsSync(dir)
    })
    if (removed === true) report.removed.push(dir)
  }

  // 5) 投影缓存：先走 storageDomain（权威内存表），再兜底删文件
  const domain = ctx.get('storageDomain')?.get?.('session_projcache')
  for (const key of idSpellings(sessionId)) {
    if (domain !== undefined) {
      await attempt(report, `projcache ${key}`, () => domain.table('sessions').delete(key))
    }
    const file = join(home, 'storages', 'session_projcache', 'sessions', `${key}.json`)
    if (!existsSync(file)) continue
    const removed = await attempt(report, `rm-projcache ${key}`, async () => {
      await rm(file, { force: true })
      return !existsSync(file)
    })
    if (removed === true) report.removed.push(file)
  }

  // 6) 前端行移除
  await attempt(report, 'emit-removed', () => {
    ctx.emit('api-session/removed', sessionId)
  })

  report.stillLive = sessions?.get?.(sessionId) !== undefined
  report.ok = !report.steps.some((step) => step.ok === false && /^rm-|^detached$|^projcache/.test(step.step))
  return report
}

/** 当前仍 live 的会话（诊断）。 */
function liveSessions(ctx) {
  const agents = ctx.get('agents')
  const sessions = ctx.get('sessions')
  return (sessions?.list?.() ?? []).map((session) => ({
    sessionId: session.id,
    cwd: session.header?.cwd,
    agent: agents?.get?.(session.id)?.status ?? 'none',
  }))
}

export default {
  inject: ['webServer', 'connection'],
  apply(ctx) {
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: 'prefix',
          path: ROUTE_PREFIX,
          handler: async (req, res) => {
            const rejection = requestRejection(ctx, req)
            if (rejection) {
              json(res, rejection, { ok: false, error: '未授权' })
              return
            }
            try {
              const path = new URL(req.url ?? '/', 'http://localhost').pathname
              const action = path.slice(ROUTE_PREFIX.length).replace(/^\/+/, '')

              if (action === 'live' && req.method === 'GET') {
                json(res, 200, { ok: true, live: liveSessions(ctx) })
                return
              }

              if (action === 'delete' && req.method === 'POST') {
                const body = await readJson(req)
                const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
                if (sessionId === '') {
                  json(res, 400, { ok: false, error: '缺少 sessionId' })
                  return
                }
                const live = ctx.get('sessions')?.get?.(sessionId) !== undefined
                if (live) {
                  // 热会话：先回响应，再后台清理，避免删到本轮自己时把响应掐断。
                  json(res, 202, { ok: true, deferred: true, sessionId })
                  setTimeout(() => {
                    const report = { sessionId, ok: true, removed: [], steps: [] }
                    cleanup(ctx, sessionId, report).catch((error) => {
                      ctx.logger?.warn?.(`session-delete: background cleanup failed: ${String(error)}`)
                    })
                  }, 30)
                  return
                }
                const report = await cleanup(ctx, sessionId, { sessionId, ok: true, removed: [], steps: [] })
                json(res, 200, report)
                return
              }

              json(res, 404, { ok: false, error: '接口不存在' })
            } catch (error) {
              if (!res.headersSent) json(res, 500, { ok: false, error: String(error?.message ?? error) })
              else res.end()
            }
          },
        }),
      'dsh-session-delete: /session-delete routes',
    )
  },
}
