# dsh-session-delete

> 彻底删除 DeepSeek Harness (DSH) 的历史会话 —— 不只是从前端列表移除，连后端日志、投影缓存和工作区登记一并清掉。

会话行右键菜单里会多出一项 **「彻底删除会话」**，确认后真正删除该会话的全部数据。

![license](https://img.shields.io/badge/license-MIT-blue.svg) ![dsh](https://img.shields.io/badge/dsh-%3E%3D0.2.2--rc.1-green.svg)

## 功能

- 在会话行右键菜单（工作区与「未分组」共用）加入 **「彻底删除会话」**
- 删除内容：
  | 落盘位置 | 内容 | 处理 |
  | --- | --- | --- |
  | `~/.dsh/sessions/<projectKey>/<sessionId>/` | 会话日志 `session.v4.jsonl.zstd` + `session.lock` | 整个目录删除 |
  | `~/.dsh/storages/workspace.json` | `archivedSessionIds` / `pinnedSessionIds` / 工作区 `sessionIds` | 从三处摘除 |
  | `~/.dsh/storages/session_projcache/sessions/<id>.json` | 投影缓存 | 走 `storageDomain` 删除 + 文件兜底 |
  | 进程内存 | `sessions` / `agents` 注册表里的会话对象 | 解除 agent 作用域 + `detachEntered` |
  | 前端列表 | 会话行 | `ctx.emit('api-session/removed', id)` |

## 为什么删除有先后顺序

1. **先停活动**：`workspaceRegistry.archiveSession(id, { stopActivity: true })` 是官方准入通道，会同时停掉 turn / job / subagent / schedule 四类活动。
2. **再解除内存中的会话**：这一步必须早于删目录。会话仍 live 时，持久化写句柄在 `session/disposed` 监听里才 `close()` 并 drain 缓冲；先删目录会让 drain 把日志重新写回，会话「复活」。
3. **最后删盘与登记**：撤销归档/pin → 从工作区摘除 → 删日志目录 → 删投影缓存 → 通知前端。

热会话（正在运行的那个）走 `202 { deferred: true }` + 后台清理，避免删到自己当前这一轮时把 HTTP 响应一起掐掉。

## 安装

### 方式一：通过插件市场（推荐）

1. DSH 侧栏 → **插件** → **实验性插件** → 启用 **「自定义插件索引」**
2. 插件页出现 **「已安装 / 发现」** 两个标签，切到 **「发现」**
3. 点 **「添加索引源」**，粘贴：

   ```
   https://huluwa-commits.github.io/dsh-session-delete/market-index.json
   ```

4. 在列表里找到 **「彻底删除会话 / dsh-session-delete」**，点安装

> 索引由第三方（本仓库）提供，安装前 DSH 会显示信任提示，请自行核对来源。

### 方式二：手动安装（git clone）

```bash
git clone https://github.com/huluwa-commits/dsh-session-delete.git /path/to/dsh-session-delete
```

然后在你的 desktop profile 的 `package.json` 里加入：

```json
{
  "dependencies": {
    "dsh-session-delete": "link:/path/to/dsh-session-delete"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-session-delete"]
    }
  }
}
```

重载 DSH 即可。

## 使用

在侧栏会话列表里，把鼠标移到任意会话行上，点出现的 **「⋯」**（操作按钮），菜单里选 **「彻底删除会话」**，在确认框里再点一次 **「彻底删除」**。

## 接口

插件在 DSH web 服务上注册两条路由，均走 `connection.requestRejection()` 鉴权（无会话 Cookie 返回 401）：

- `GET  /session-delete/live` — 当前仍 live 的会话（诊断用）
- `POST /session-delete/delete` — body `{ "sessionId": "session-xxxx" }`

## 已知边界

- **空会话没有右键菜单**：DSH 内置行为对 `blank` 会话不绑定上下文菜单，因此新建但没发过消息的会话无法通过右键删除（这是宿主限制，不是本插件的问题）。
- **删除不可撤销，没有回收站**。确认框是唯一的护栏，请确认选中的会话确实不再需要。
- 删除当前正在运行的会话时，数据会在后台清理，界面可能要重启 DSH 后才完全刷新。

## 许可证

MIT — 见 [LICENSE](LICENSE)。
