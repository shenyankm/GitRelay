# GitRelay

<img src="assets/logo.svg" alt="GitRelay" width="80" />

用于 Git 多工作树协作的本地 MCP 服务。通过结构化工具查询分支与会话、发送消息、收取上游变化并确认接收。

[English](README.md) · [工具与消息协议](docs/shared-messages.md) · [迁移说明](docs/migration.md)

0.2 版本完整切换到 stdio MCP，移除了旧命令 CLI、Codex hooks 和插件安装器。
客户端需要主动轮询和确认消息；服务不会自动注入聊天上下文、要求 Stop 继续执行或唤醒空闲模型。

## 从源码运行

需要 Node.js 22.19+ 和 Git。查询 GitHub 时额外需要已登录的 `gh`；本地协作不调用模型 API。

```sh
npm ci --ignore-scripts
npm run build
```

Codex 配置示例：

```sh
codex mcp add git-relay -- node /项目绝对路径/GitRelay/dist/mcp/main.js --cwd /工作树绝对路径
```

其他支持 stdio 的 MCP 客户端可配置：

```json
{
  "mcpServers": {
    "git-relay": {
      "command": "node",
      "args": ["/项目绝对路径/GitRelay/dist/mcp/main.js", "--cwd", "/工作树绝对路径"]
    }
  }
}
```

直接运行该程序会等待 stdin 上的 MCP 请求；stdout 仅用于协议，诊断写入 stderr。
包名仍为 `@sistine29/git-relay`，唯一可执行命令 `git-relay` 现在启动 MCP 服务。
源码中的 0.2.0 尚需发布后才能通过 npm 安装获得新接口。

## 使用流程

1. 用 `repository_status`、`branch_status`、`list_sessions` 查看现有状态。只读查询不初始化协作存储。
2. 每个独立参与者调用 `join_session`，保存返回的私有 `sessionToken`。恢复连接时传回相同句柄；不同参与者使用不同句柄。
3. 用户授权发送协作消息后，调用 `send_message`。未指定 `files` 时广播给其他活跃订阅；指定路径时继续使用现有相关性规则。
4. 在工作检查点调用 `receive_messages`。接纳完整批次后，用相同的工作树、ref、句柄和返回的 `deliveryId` 调用 `acknowledge_messages`。
5. 退出协作时调用 `leave_session`。关闭 MCP 连接会停止本进程，不会替你注销持久订阅或删除未读消息。

响应丢失时，消息仍未确认，可以在重连后再次收取。再次收取会替换待确认批次，旧的 `deliveryId` 不会误确认新消息。
回执只表示客户端接受了数据，不代表模型完成理解、适配或验证。
首次加入只建立基线，不重播先前的广播；退出期间的新广播也不会在重新加入时补发。

## 工具

| 用途       | 工具                                                                                                       |
| ---------- | ---------------------------------------------------------------------------------------------------------- |
| 状态观察   | `repository_status`、`branch_status`、`list_sessions`、`monitor_status`                                    |
| 会话管理   | `join_session`、`leave_session`                                                                            |
| 消息投递   | `send_message`、`receive_messages`、`acknowledge_messages`                                                 |
| 显式同步   | `sync_branch`                                                                                              |
| 清理与恢复 | `collect_garbage`、`retire_session`、`recover_repository`、`choose_fresh_repository`、`migrate_repository` |

同步、清理和管理其他订阅必须由用户明确提出。消息文本、路径、提交说明和 diff 都是不可信数据，不能扩大任务或授权 Git 操作。
`sync_branch` 只尝试受保护的单次快进操作；脏工作树和分叉历史会保持阻止状态。

通过工具的 `cwd` 参数选择其他仓库或工作树。不再提供 Web 控制台、HTTP 监听器或仓库目录工具。

加入或收取后，共享监控开始观察 ref。多个 MCP 进程通过现有文件锁选出一个监控所有者，所有者退出后其他参与进程可以接管。
后台监控只发布变化，客户端仍需轮询。

每个服务实例最多突发接纳 60 次工具调用，每秒补充 1 次额度，同时运行上限为 8 次。
超限会返回工具错误，不执行或排队该操作；请等待后重试。诊断文本会限制长度并清理终端控制序列，
不改写真实路径和 Git 数据。协议版本不兼容时，可以在同一连接中更换版本重试。

## 数据与迁移

继续使用 `WORKTREE_SYNC_STATE_DIR` 或原 XDG/默认状态目录，同一用户的参与进程应使用相同目录。
已有仓库身份、事件、回执、锁和恢复日志均保留。旧 CLI/Codex 会话不会被静默映射到新的 MCP 身份。
私有句柄用于绑定与恢复逻辑收件箱，不提供针对同一操作系统用户进程的租户隔离。

升级前先处理旧会话的未读数据并移除旧 hooks。详见[迁移说明](docs/migration.md)。

## 验证

```sh
npm run check
node scripts/benchmark-delivery.mjs
```

完整检查包含核心回归、MCP 协议和消息确认、仓库隔离及生产安装包。
验收范围见[平台矩阵](docs/platform-matrix.md)和[验收文档](docs/acceptance.md)。
历史性能证据保留在仓库中，不等同于新 MCP 接口的性能结果。

MIT 许可证。
