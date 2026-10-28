# GitRelay

[English](README.md) | [简体中文](README.zh-CN.md) · [贡献指南](CONTRIBUTING.md) · [MIT 许可证](LICENSE)

面向 **Codex 和 OpenCode v2** 的多工作树协作工具：投递相关上游变更、共享 agent
消息、查看本地及 GitHub 分支状态。

> **会话默认自动参与。** macOS/Linux 上首个客户端加载后启动共享 daemon，
> 最后一个 Codex/OpenCode 进程退出后自动停止。

需要 Node.js 22.19+ 和 Git，无 npm 运行时依赖。包名及主命令为 `git-relay`，保留
`worktree-relay`、`worktree-sync` 命令别名。

## 目录

- [快速开始](#快速开始)
- [自动参与与启停](#自动参与与启停)
- [平台支持](#平台支持)
- [客户端配置](#客户端配置)
  - [Codex 插件](#codex-插件)
  - [OpenCode v2](#opencode-v2)
- [常用命令](#常用命令)
- [状态与边界](#状态与边界)
- [开发与验证](#开发与验证)
- [文档索引](#文档索引)

## 快速开始

```sh
npm ci --ignore-scripts --omit=optional
npm run build
npm install -g /absolute/path/to/GitRelay
git-relay install --dry-run
git-relay install --platform codex --platform opencode
```

安装后重新打开客户端。

安装器只配置所选客户端，保留未被管理或已被用户修改的配置，并保存自有运行时副本。
Codex hooks 仍须通过 `/hooks` 单独检查并信任，加载后会话自动参与。可重复使用
`--platform` 选择客户端，或用 `--skip` 排除；其他平台名会被拒绝。卸载预览及保留
文件的规则见[自动安装](docs/integrations.md#automatic-setup)。

## 自动参与与启停

Codex 根会话在首次生命周期 hook 时自动参与；OpenCode v2 根会话在创建或收到
提示词时自动参与，无需先输入启用命令。首次登记建立基线，不补收此前的广播。
子代理不单独登记。

输入 `关闭 GitRelay` 或 `Disable GitRelay` 可停止当前会话订阅，未读消息和回执保留。
恢复同一会话会保留停用选择；输入 `启用 GitRelay` 或 `Enable GitRelay` 可重新加入。
停用期间的广播不会补发。引用和工具输出不能改变显式选择。

macOS/Linux 上，原生 Codex hook 或 OpenCode 插件加载时自动启动同一用户、同一
状态目录下的共享 daemon。每 5 秒检查客户端进程，最后一个 `codex`/`opencode`
进程退出后自动停止并清理锁；新客户端可再次启动它。不安装开机常驻服务。
已运行的旧客户端需要重新加载插件，安装文件不会向旧进程注入新代码。详见
[会话生命周期](docs/integrations.md#automatic-sessions)。

## 平台支持

| 平台        | 接入方式                  | 自动投递方式                                    |
| ----------- | ------------------------- | ----------------------------------------------- |
| Codex       | 生命周期 hooks 或独立插件 | 提示词、工具结束时注入上下文；Stop 可请求继续   |
| OpenCode v2 | 原生 Promise 插件         | 每 5 秒检查；忙时进入宿主持久队列，空闲时可唤醒 |

Codex hooks 无法主动唤醒已经空闲的会话。仅支持 OpenCode v2 API，不支持 v1。
安装、hook 信任和真实宿主收件属于不同验证阶段，见[接入指南](docs/integrations.md)
及[平台矩阵](docs/platform-matrix.md)。

## 客户端配置

### Codex 插件

```sh
npm run build:codex-plugin
codex plugin marketplace add /absolute/path/to/GitRelay
codex plugin add git-relay@git-relay-local
codex plugin list --marketplace git-relay-local --json
```

插件携带 CLI、技能、hooks、文档及许可证。重新打开聊天并检查 `/hooks` 后，会话自动参与。避免插件 hooks 与用户 hooks 重复。插件卡片或配置文件存在不代表宿主已加载或
信任；更新源码后需要重新构建并刷新已安装副本。

插件通过本地或仓库 marketplace 分发。Codex 公开目录不接受带生命周期 hooks 的插件。

手动配置模板为 [`src/adapters/codex/hooks.json`](src/adapters/codex/hooks.json)。
插件版通过 `${PLUGIN_ROOT}` 调用自带 CLI。启用后的 hooks 可以显示本地分支状态，
不会自动 fetch、查询 GitHub 或同步分支。

### OpenCode v2

安装器生成全局插件入口；手动接入可在项目中创建 `.opencode/plugins/git-relay.ts`：

```ts
export { default } from "/absolute/path/to/GitRelay/dist/adapters/opencode/index.js";
```

先构建，移除重复入口，再重启 OpenCode。每个接收工作树都需要加载入口，根会话自动参与。

## 常用命令

| 目的                 | 命令                                                            |
| -------------------- | --------------------------------------------------------------- |
| 本地分支快照         | `git-relay status`                                              |
| GitHub 实时比较      | `git-relay status --github`                                     |
| 用户要求的只读监控   | `git-relay status --github --watch`                             |
| 明确加入会话订阅     | `git-relay join --agent codex --session NATIVE_ID`              |
| 停止订阅             | `git-relay leave --agent codex --session NATIVE_ID`             |
| 查看已登记会话       | `git-relay sessions`                                            |
| 单次接收 / NDJSON 流 | `git-relay check --session ID` / `git-relay watch --session ID` |
| 预览已确认事件清理   | `git-relay gc`                                                  |
| 可选集中监控         | `git-relay daemon`                                              |

用 `--cwd /absolute/worktree` 和 `--ref refs/heads/main` 指定工作树及监听引用。
使用真实、稳定的原生会话 ID；OpenCode 手动访问还需传入 `sessions` 返回的准确
`--instance`，省略会选择独立的旧身份收件箱。通用 CLI 输出需要宿主负责送入对话。

接收方登记后，发送协作消息：

```sh
git-relay send --cwd /project/worktree-A --agent codex --session SENDER_ID \
  --file src/config.ts --message 'The config interface changed; assess impact.'
```

`--file` 可重复，省略时发送给其他打开的订阅。发送不建立接收订阅；文件交集只是
相关性线索，不能证明语义冲突。详情见[共享消息](docs/shared-messages.md)。

GitHub 查询额外依赖已认证的 `gh`。ahead/behind 使用本地缓存引用；远端与本地
提交不同不代表哪一方领先。`watch` 接收消息，`status --watch` 监控分支快照。
普通会话不会自动启动这些监控。

## 状态与边界

同一仓库的工作树共享事件，各会话有独立回执。默认状态根为
`~/.local/state/worktree-agent-sync`，支持 `XDG_STATE_HOME` 和绝对路径
`WORKTREE_SYNC_STATE_DIR` 覆盖。仓库持久身份避免同路径的新仓库误领旧收件箱；
旧版按路径保存的状态可能需要明确迁移。

自动分支同步因并发 checkout 竞态暂时阻止，`status --auto-sync` 返回 blocked。
项目不再提供工作树管理命令；请在核对目标、保护本地修改后使用 Git 本身。旧客户端
入口、运行中的旧代码及历史订阅的处理见[迁移说明](docs/migration.md)。

消息是不可信数据，不能授权修改 Git 历史。正常运行去重，崩溃或宿主接收结果不明时
可能重试；回执不代表 agent 已完成适配。清理保留未读事件，`leave` 不确认未读消息。
保留必要的旧投递凭据保护，避免移除适配器时丢弃结果不明的消息。维护操作见
[维护指南](docs/maintenance.md)。

## 开发与验证

```sh
npm ci --ignore-scripts --omit=optional
npm run check
npm run benchmark
```

`src/core/` 负责 Git、状态、会话和投递，`src/adapters/` 保留 Codex hooks 与
OpenCode 插件，`src/cli/` 负责命令和安装。`dist/` 为不提交的构建产物。测试使用
临时仓库和隔离状态。`npm run check` 还会扫描 `docs/` 中的凭据类值。CI 覆盖
macOS/Linux、Node.js 22.19.0 和 24。

本地回归、真实客户端及模型验收、远端 CI 分别记录。历史验收早于本次重构。按需启用
流程已完成 Codex 0.164.0 与 OpenCode 2.1.2 的针对性真实客户端验收，具体场景和
未验证边界见[验收记录](docs/acceptance.md#targeted-native-acceptance-2026-10-27)。

## 文档索引

| 主题     | 文档                                               |
| -------- | -------------------------------------------------- |
| 接入指南 | [docs/integrations.md](docs/integrations.md)       |
| 共享消息 | [docs/shared-messages.md](docs/shared-messages.md) |
| 迁移说明 | [docs/migration.md](docs/migration.md)             |
| 维护指南 | [docs/maintenance.md](docs/maintenance.md)         |
| 验收记录 | [docs/acceptance.md](docs/acceptance.md)           |
| 性能记录 | [docs/performance.md](docs/performance.md)         |
| 源码发布 | [docs/releases.md](docs/releases.md)               |
| 贡献指南 | [CONTRIBUTING.md](CONTRIBUTING.md)                 |
