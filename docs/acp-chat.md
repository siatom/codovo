# ACP 对话面板

给 Codovo 的 AI CLI 增加一条 **GUI 对话通道**：终端里的 PTY 方式保持原样，另外用
[Agent Client Protocol (ACP)](https://agentclientprotocol.com/) 把支持 ACP 的 CLI
以 stdio 子进程接进来，在中间区用「终端 / 对话」分段开关切换。

## 为什么是 ACP

- **不解析 TUI**：ANSI 屏幕抓取既脆弱又拿不到工具调用、计划、权限这些结构化信息。
- **不重复实现 Agent**：文件读写、命令执行、上下文管理仍由 CLI 自己做，Codovo 只做客户端。
- **一家实现、多家复用**：ACP 是稳定 v1 协议，opencode / CodeBuddy / Gemini / Copilot / Qoder
  等已有入口；后续适配器（Codex、Claude Code）也能接进来。
- **和现有助手不冲突**：右栏「应用助手」是进程内 Rig 运行时，负责改 Codovo 自己的设置
  与界面；对话面板是「真正的 CLI」，两者事件、状态、生命周期完全分开。

## 架构

```
┌───────────────────────────── WebView ─────────────────────────────┐
│ TerminalPane                                                     │
│   ├─ 终端视图（不变）：标签栏 + PTY 会话                          │
│   └─ 对话视图：AcpChatPane                                        │
│         ├─ lib/acp.ts  事件 reducer + invoke 封装 + localStorage    │
│         └─ 一个 CLI 多条对话（按 root + provider 归档）             │
└───────────────▲──────────────────────────────┬───────────────────┘
                │ acp-event（root + chatId）    │ acp_* 命令
┌───────────────┴──────────────────────────────▼───────────────────┐
│ src-tauri/src/acp                                                │
│   AcpState：chatId → Chat（root / provider / connector / 权限）   │
│   一个 root/provider 配置共享子进程，每个 chatId 一个独立 session  │
│   agent-client-protocol v5（只用稳定 v1 + process 特性）          │
└───────────────┬──────────────────────────────────────────────────┘
                │ stdio JSON-RPC（ACP v1）
        ┌───────▼────────┐
        │ opencode acp   │  CodeBuddy --acp  Gemini --acp  ...
        └────────────────┘
```

### 后端模块

- `src-tauri/src/acp/launch.rs`
  - provider key → ACP 入口参数：opencode 用 `acp` 子命令，其余原生支持项用 `--acp`。
  - Codex / Claude Code 走官方适配器（`npx -y @agentclientprotocol/...`）。
  - 复用 `launch::resolve_launch` 解析可执行文件；Windows 上 npm 的 `.cmd` 垫片
    借 `cmd /C` 起，避免 CreateProcess 直接报错（不加 `/S`，否则带空格路径的引号会被剥掉）。
  - 用户命令里已有的参数保留（`opencode --auto` → `opencode --auto acp`）。
- `src-tauri/src/acp/event.rs`
  - `acp-event` 的载荷：`{ root, chatId, event }`。
  - `event.type`：`ready` / `update` / `permission` / `promptDone` / `error` / `closed`。
- `src-tauri/src/acp/mod.rs`
  - `AcpState`：进程级 chat 表与共享 AgentRuntime 表；按工作区 root 收摊。
  - `Chat`：connector（`ConnectionTo<Agent>` + ACP session id）、pending 权限、
    busy 标记、stop 通道。
  - 命令：`acp_start` / `acp_prompt` / `acp_cancel` / `acp_respond_permission` /
    `acp_stop` / `acp_status`。

### 协议映射

| ACP | Codovo |
| --- | --- |
| `initialize` | `acp_start` 内完成；`agent_info` 存进 `AcpInfo` |
| `session/new` | `acp_start` 内完成，cwd 来自活动根，其余工作区根进 `additionalDirectories`；子进程启动前先 `cd` 到 cwd（SDK 不设进程工作目录，CodeBuddy 实测按进程 cwd 写文件） |
| `session/load` | 传了 `resumeSessionId` 且 Agent 支持时优先用它：Agent 会把历史当 `session/update` 重放，前端收到 `ready` 时清掉本地旧块再接收 |
| `session/resume` | 只支持 resume 的 Agent 走这条：不重放历史，前端继续用本地存档；都不支持则退回新会话并给一条提示 |
| `session/prompt` | `acp_prompt` 用连接直接发请求，响应回 `promptDone` |
| `session/update` 通知 | 原样 JSON 转发成 `update`，前端按 `sessionUpdate` 判别 |
| `session/request_permission` | 存下 responder，发 `permission`；用户选择后回 `acp_respond_permission` |
| `session/cancel` 通知 | `acp_cancel`；挂着的权限请求按 `cancelled` 回掉 |
| 子进程退出 / 连接关闭 | `closed`，同一 chatId 可由前端重新 `acp_start` |

会话更新里目前前端消费：`agent_message_chunk`、`agent_thought_chunk`、
`user_message_chunk`（恢复历史时重放）、`tool_call`、`tool_call_update`、`plan`、
`current_mode_update`、`usage_update`。其余类型原样忽略，不阻塞后续消息。

### 前端

- `src/lib/acp.ts`
  - `AcpChat` 状态：`blocks[]`（user / assistant / thought / tool / plan / notice）、
    `sessionId`、`permission`、`busy`、`phase`、`info`、`mode`、`usage`。
  - `reduceAcpEvent` 是纯函数：文本块只在「上一块还是同类型流式块」时追加，中间插入
    工具卡后自然另起一块。收到 `ready` 且 Agent 要重放历史（`resumed && canLoad`）时，
    只保留带 `local` 标记的用户消息，其余交给重放。
  - 存档在 localStorage（`codovo.acpChats`）：按「工作区根 + 命令」存多条对话的
    ACP session id 与精简后的消息记录；工具正文 / diff 只留摘要，最多 40 块。
    这份存档是 Codovo 的界面缓存，不代表 Agent 的完整对话数据库；完整 session
    是否由 Agent 持久化、能否通过 ACP 列出或恢复，取决于 Agent 实现的可选能力。
- `src/components/AcpChatPane.tsx`
  - 头部两行：CLI / Agent 版本 / 模式 / 上下文用量 / 结束对话；下面一排对话标签，
    同一家 CLI 最多并行 6 条，各自的 ACP session 独立，共享 provider 子进程。
  - 面板重新挂载时先读存档，再用 `acp_status` 问后端进程还在不在：还在就接上，
    不在就等下一条消息按 `sessionId` 恢复；Agent 不支持恢复时清空旧记录并提示。
  - 消息区复用 `useStickToBottom`；助手正文复用 `useHighlightedMarkdown` +
    `useMermaidBlocks`，和 `AgentMessageView` 同一套渲染规则。
  - 工具卡展示状态、类型、路径，以及 text / diff 内容。
  - 权限卡固定在输入框上方，默认一次一确认，不做自动批准。
- `src/components/TerminalPane.tsx`
  - 顶栏右侧新增「终端 / 对话」分段开关；对话视图下同一排 CLI 按钮改成切换 provider。
  - 对话面板始终挂载、切走只是 `hidden`，所以切回终端不会丢消息或断开 ACP 会话。
  - 终端标签模型未改动。
- `src/components/SettingsDialog.tsx`
  - 「系统支持」里给能进对话面板的 CLI 标一枚「支持对话」。

### 生命周期与安全

- 同一工作区 root/provider/command/env 配置共享一个 ACP 子进程与连接，每个 `chatId`
  持有独立 ACP session；同一条对话同一时刻只允许一轮 prompt（`busy`）。
- 关闭工作区：`workspace_close` 调 `acp::stop_root`，按 root 收掉该工作区所有对话。
- 退出应用：`RunEvent::ExitRequested / Exit` 调 `AcpState::kill_all`。
- 启动超时 60 秒；超时直接 abort 任务，连接 future 被 drop 时 SDK 会 kill 进程。
- ACP session 的 `cwd` 与所有 `additionalDirectories` 都必须通过
  `FsState::checked_root`，未登记的工作区目录直接拒绝。
- 权限请求不自动批准；取消一轮时按协议把 pending 权限回 `cancelled`。

## CLI 支持矩阵

| CLI | 入口 | 状态 |
| --- | --- | --- |
| opencode | `opencode acp` | 已接入，UI 实测 `initialize → session/new → prompt → 工具调用` |
| CodeBuddy | `codebuddy --acp` | 已接入，UI 实测对话与写文件工具调用（cwd 修正后落在工作区根） |
| Gemini CLI | `gemini --acp` | 已接入，按版本验证开关名 |
| GitHub Copilot CLI | `copilot --acp` | 已接入，按版本验证开关名 |
| Codex | `npx -y @agentclientprotocol/codex-acp` | 已接线；首次运行由 npx 下载适配器，沿用本机 Codex 登录 / API key |
| Claude Code | `npx -y @agentclientprotocol/claude-agent-acp` | 已接线；依赖 Node 与 Claude Code 的登录 / API key |
| Qoder CLI | `qodercli --acp` | 已接入；复用 Qoder CLI 登录状态（[官方说明](https://docs.qoder.com/cli/acp)）；CLI 支持 `--resume` / `--list-sessions`，ACP `session/list` 能力仍以运行时声明为准 |
| Qwen / Antigravity / iFlow | — | 暂无稳定 ACP 入口，继续只在终端里跑 |

不在矩阵里的 CLI 在对话视图里显示为禁用，不会猜参数去启动。
Codex / Claude Code 用的是官方适配器，后端不把设置里的命令传进去——适配器自己带
对应 CLI，用户的 codex / claude 命令只用于终端。

## 验证

```bash
pnpm build
cd src-tauri && cargo test --lib acp::
cd src-tauri && cargo test --lib acp_probe -- --ignored --nocapture
cd src-tauri && cargo test --lib acp_probe_qoder_initialize -- --ignored --nocapture
```

`acp_probe_opencode` 是手动集成测试：本机装好并登录 opencode 后，它会真实走一遍
`initialize → session/new × 2（同一 connection）→ prompt → 流式文本`，用来确认 SDK 与 CLI 入口没有漂移，并检查同一进程承载多个 session。
`acp_probe_qoder_initialize` 使用已安装并登录的 Qoder CLI，验证官方 `--acp` 入口能完成 `initialize` 握手。
CI 不跑（`#[ignore]`）。

界面验证按 `.codebuddy/skills/cdp-verify/` 用 `scripts/cdp-check.cjs`：

1. 打开工作区，顶栏切到「对话」，选 opencode；
2. 发一条普通消息，确认助手正文流式出现；
3. 触发一次写文件操作，确认权限卡出现、取消后 Agent 收到拒绝；
4. 切回「终端」，标签与 PTY 输出仍在；
5. 点对话标签栏的加号再开一条，两条对话来回切，消息各自独立；
6. 切走工作区再切回来、或重启应用，确认旧记录还在，下一条消息前显示「已恢复」；
7. 关工作区，确认 `opencode acp` 子进程退出。

## 分阶段

- **Phase 0（已完成）**：SDK 接入、opencode 全链路探针。
- **Phase 1（已完成）**：opencode / CodeBuddy / Gemini / Copilot 的启动映射、
  对话面板、权限卡、工具卡、计划、停止与工作区收摊。
- **Phase 2（已完成）**：`session/load` / `session/resume` 恢复、本地存档、
  多对话标签、安装检测里标出「支持对话」。
- **Phase 3（已完成）**：Codex / Claude Code 适配器已接线；`session/list` 与侧栏历史合并已接入；同一工作区与 provider 配置共享 ACP 子进程，各对话仍使用独立 session。

## 已知限制

- Codovo 将精简后的消息摘要与 ACP session id 存入 localStorage；完整对话历史由 Agent
  自己管理（若其实现了持久化）。换机器、清缓存或换 WebView 数据目录会丢失 Codovo
  的本地摘要；要恢复 Agent 侧历史，Agent 还需支持 `session/load` / `session/resume`。
- 一个 CLI 在一个工作区里最多同时开 6 条对话，同一工作区/provider/命令/环境配置复用一个 ACP 子进程。
- 未 advertise `fs` / `terminal` 客户端能力，依赖客户端文件系统的 Agent 需要后续补。
- Qoder 可通过 ACP 使用 IDE 提供的文件与终端能力；Codovo 当前未 advertise `fs` / `terminal`，因此本次接入不包含这两类客户端能力，Qoder 仍可使用其 ACP 内置工具。
- 侧栏以 CLI 自己写在磁盘上的记录为主；配置了 ACP CLI 时会尝试补充其 `session/list`，
  Agent 未声明 list 能力或查询失败时仅显示磁盘记录。Qoder CLI 官方提供 `--resume` 与
  `--list-sessions`，但这不等于 ACP Agent 一定声明 `session/list`；ACP 历史条目沿用 CLI
  的 resume 命令恢复。
- Qoder 的 CLI 历史持久化与 ACP session 持久化是两条入口：本接入复用 Qoder 登录状态，
  ACP 初始化入口为 `qodercli --acp`；当前尚未完成本机 ACP 初始化探测，不能据此确认
  Qoder ACP 端是否公开 `session/list` / `session/load` / `session/resume`。
- Windows 上所有 ACP 进程都经 `cmd /C` 启动（`.cmd` 垫片 + 设置 cwd）；SDK 在 Windows
  只 kill 直接子进程，异常退出时依赖 stdin EOF 让 CLI 自行结束。
- 权限卡的后端链路已实现，但 opencode / CodeBuddy 在本机默认配置下会自动批准写文件，
  UI 自动批准路径需要换一个会发 `session/request_permission` 的 Agent 再验。
- Codex / Claude Code 适配器经 `npx -y` 启动，第一次会下载；离线环境或没有 Node 时不可用。
