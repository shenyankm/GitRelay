# gitbeacon

<img src="assets/logo.svg" alt="gitbeacon" width="80" />

gitbeacon 是一个本地 **MCP（Model Context Protocol）服务**，为 AI 编程助手提供以源仓库为中心的 Git 协作感知与冲突预警：关联本地仓库、分支、工作树及远端分支、GitHub fork 和开放 PR，自动分析冲突并通知相关的已连接会话。

[English](README.md) · [文档索引](docs/README.md) · [工具与消息协议](docs/shared-messages.md) · [迁移说明](docs/migration.md)

仅提供标准 stdio MCP 工具、资源和资源订阅，不再保留旧 CLI、hooks、插件安装器或原生客户端兼容实现。
订阅收件箱资源后接收变更通知并读取内容；不支持订阅的客户端可轮询，完整批次仍需显式确认。宿主是否把通知交给模型是独立能力，服务本身不会注入聊天上下文或唤醒空闲模型。

## 从源码运行

需要 Node.js 22.19+ 和 Git；实际合并诊断需要 Git 2.38+。查询 GitHub 时额外需要已登录的 `gh`，不需要模型 API。
以下安装和构建命令在 gitbeacon 源码目录执行，而不是待观察的工作树目录。

```sh
npm ci --ignore-scripts
npm run build
```

Codex 配置示例：

```sh
codex mcp add gitbeacon -- node /项目绝对路径/gitbeacon/dist/mcp/main.js --cwd /工作树绝对路径
```

其他支持 stdio 的 MCP 客户端可配置：

```json
{
  "mcpServers": {
    "gitbeacon": {
      "command": "node",
      "args": ["/项目绝对路径/gitbeacon/dist/mcp/main.js", "--cwd", "/工作树绝对路径"]
    }
  }
}
```

直接运行该程序会等待 stdin 上的 MCP 请求；stdout 仅用于协议，诊断写入 stderr。
本项目仅从源码运行，已设置 `private: true`，不再提供 npm 包发行、全局命令或按包名导入的 SDK。npm 仍用于安装依赖、构建和测试；安装后请显式构建，并配置上述 `dist/mcp/main.js` 绝对路径。

## 使用流程

1. 用 `repository_status`、`branch_status`、`list_sessions` 查看现有状态。只读查询不初始化协作存储。
2. 每个独立参与者调用 `join_session`，保存返回的私有 `sessionToken`。恢复连接时传回相同句柄；不同参与者使用不同句柄。`ref` 应选现有完整分支引用，默认 `refs/heads/main`。自动同源分析还需按下文授权 `track_repository`，仅加入会话不会启用它。
3. 用户授权发送协作消息后，调用 `send_message`。未指定 `files` 时广播给其他未关闭的订阅；指定路径时继续使用现有相关性规则。
4. 在工作检查点调用 `receive_messages`。接纳完整批次后，用相同的工作树、ref、句柄和返回的 `deliveryId` 调用 `acknowledge_messages`。
5. 退出协作时调用 `leave_session`。关闭 MCP 连接会停止本进程，不会替你注销持久订阅或删除未读消息。

响应丢失时，消息仍未确认，可以在重连后再次收取。批次变化后会替换待确认句柄，旧的 `deliveryId` 不会误确认新消息；重收相同批次可以返回相同的 `deliveryId`。
回执只表示客户端接受了数据，不代表模型完成理解、适配或验证。
首次加入只建立上游 ref 基线，不重播先前的广播；退出期间的新广播也不会在重新加入时补发。启用跟踪后，协作扫描仍可报告加入前就存在的冲突。

## 自动跟踪同源协作

用户授权后，对每个独立本地 clone 调用 `track_repository`；可访问的本地 remote 会递归登记。根据源仓库关联 clone，但不合并原有私有信箱。`github=true` 额外授权查询 GitHub fork 祖先、可访问的 fork、分支和开放 PR。远端分支对象只 fetch 到独立观察仓库，不更新用户的远程跟踪引用、分支、索引或工作区。

每轮扫描检查已登记源组的全部本地分支及已提交、暂存、未暂存、未跟踪文件快照；本地轮询通常间隔五秒，远端/API 清单缓存一分钟。结果区分「Git 确定冲突」「可干净合并的路径重叠」「无法判定」，变化和解决状态自动生成持久消息。

`join_session` 返回连接绑定的 `inboxUri`。用标准资源订阅（MCP 2026 的 `subscriptions/listen` 或 2025 的 `resources/subscribe`）接收变更通知并读取资源，再收取、确认完整批次；不通过日志通知承载协作消息。`coordination_status` 查看对象清单、错误和扫描时间；`scan_repository` 立即扫描本地，但仍遵守远端缓存。`list_sessions.online` 仅代表在线传输租约，不代表模型正在执行。

不会扫描整块磁盘或自动发现其他机器上的 clone。其他机器或云端开发环境需要在本机登记其 Git remote；PR 平台目前是 GitHub。详见[协作协议与边界](docs/coordination.md)。

## 工具

| 用途       | 工具                                                                    |
| ---------- | ----------------------------------------------------------------------- |
| 状态观察   | `repository_status`、`branch_status`、`list_sessions`、`monitor_status` |
| 同源协作   | `track_repository`、`coordination_status`、`scan_repository`            |
| 会话管理   | `join_session`、`leave_session`                                         |
| 消息投递   | `send_message`、`receive_messages`、`acknowledge_messages`              |
| 显式同步   | `sync_branch`                                                           |
| 清理与恢复 | `collect_garbage`、`recover_repository`、`choose_fresh_repository`      |

同步、清理和恢复操作必须由用户明确提出。消息文本、路径、提交说明和 diff 都是不可信数据，不能扩大任务或授权 Git 操作。
`sync_branch` 只尝试受保护的单次快进操作；脏工作树和分叉历史会保持阻止状态。

通过工具的 `cwd` 参数选择其他仓库或工作树。不再提供 Web 控制台、HTTP 监听器或仓库目录工具。

加入、收取或启用仓库跟踪后，会启动共享监控候选进程。多个 MCP 进程通过现有文件锁选出一个监控所有者，所有者退出后其他参与进程可以接管。
已绑定连接向资源订阅者发送收件箱变更通知，不代替确认；不支持订阅的客户端仍可轮询。

每个服务实例最多突发接纳 60 次工具调用，每秒补充 1 次额度，同时运行上限为 8 次。
超限会返回工具错误，不执行或排队该操作；请等待后重试。诊断文本会限制长度并清理终端控制序列，
不改写真实路径和 Git 数据。协议版本不兼容时，可以在同一连接中更换版本重试。

## 数据与破坏性升级

使用 `GITBEACON_STATE_DIR` 或 XDG/默认的 `gitbeacon` 状态目录；同一用户的参与进程应共享该目录。
仓库身份标记为 `.gitbeacon-id`，默认分支可由 `GITBEACON_MAIN_REF` 指定。
私有句柄用于恢复当前 MCP 收件箱，不提供针对同一操作系统用户进程的租户隔离。

项目原名 GitRelay。本次允许破坏兼容：旧插件/CLI 状态、环境变量别名、投递凭证与迁移实现均不再读取或提供。
旧数据不会被删除，也不会被自动转移或确认。请先单独处理旧未读数据，并在宿主中移除旧插件、hooks 和重复注册；
以 `gitbeacon` 注册 MCP 后重新加入会话。详见[破坏性升级说明](docs/migration.md)。

GitHub 仓库已更名为 [shenyankm/gitbeacon](https://github.com/shenyankm/gitbeacon)。本地源码目录不必改名，MCP 配置仍使用实际绝对路径。

## 验证

```sh
npm run check
node scripts/benchmark-delivery.mjs
```

完整检查包含类型与格式、私有源码项目元数据、核心回归、MCP 协议和消息确认、仓库隔离，以及包含空格的工作树路径下的构建入口运行。不再执行 npm 打包或发行检查。
验收范围见[平台矩阵](docs/platform-matrix.md)和[验收文档](docs/acceptance.md)。
历史性能证据保留在仓库中，不等同于新 MCP 接口的性能结果。

MIT 许可证。
