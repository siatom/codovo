# Codovo 现状盘点

> 对应开发计划：CODO-000（现有代码盘点）
> 盘点基线：`feat/codo-000-current-state`，commit `63a2bab`
> 盘点日期：2026-10-24

## 1. 结论摘要

Codovo 已经是一个可运行的本地优先桌面工作台，而不是空白的 Tauri 模板。现有产品主线是：一个窗口管理多个工作区；每个工作区保留终端、编辑器和右侧工具的运行状态；Rust 后端通过 Tauri command 提供 PTY、文件、Git、Agent、预览、远程和数据库能力。

当前实现已经覆盖 PRD 中“保留原生 CLI、PTY 兼容、工作区边界、Git/Worktree、可观察的本地工具状态”等基础条件，但 PRD 所需的平台级 `Project / Goal / Task / Task Run / Proposal / Event Store / Acceptance` 领域尚不存在。现有 Agent 会话和终端会话仍分别由 opencode/CLI 与前端状态管理，不能直接作为 Codovo Task 的持久化替代物。

因此后续实现应先在现有 command/state 边界上增加平台领域层，保留现有终端和工具模块；不要把现有 opencode session 或 xterm 标签直接重命名为 Task/Run。

## 2. 真实技术栈与入口

| 层 | 实际实现 | 证据 |
| --- | --- | --- |
| 前端 | React 19、TypeScript、Vite 8、Tailwind CSS 4 | `package.json`、`src/main.tsx` |
| 桌面壳 | Tauri 2 | `src-tauri/Cargo.toml`、`src-tauri/src/lib.rs` |
| 后端 | Rust 2021 | `src-tauri/Cargo.toml` |
| 终端 | `portable-pty` + xterm.js 6，Tauri Channel 传输出 | `src-tauri/src/pty.rs`、`src/lib/pty.ts`、`src/components/TerminalPane.tsx` |
| 编辑器 | Monaco Editor | `package.json`、`src/components/EditorPane.tsx` |
| Git | Rust 中调用 Git CLI，含 status、diff、commit、branch、stash、worktree、merge | `src-tauri/src/git.rs`、`src/lib/git.ts` |
| Agent | 每个工作区一个 opencode 子进程，HTTP/SSE；应用助手和预览助手使用 MCP 文件邮箱桥 | `src-tauri/src/agent.rs`、`src-tauri/src/app_agent.rs`、`src-tauri/src/preview_agent.rs` |
| 数据库工具 | MySQL、PostgreSQL、SQLite 连接池与只读查询/导出 | `src-tauri/src/database.rs`、`src/components/DatabasePane.tsx` |
| 持久化 | 工作区、编辑器会话、设置主要在浏览器 `localStorage/sessionStorage`；Agent 历史由 opencode 自己管理 | `src/lib/workspaces.ts`、`src/lib/session.ts`、`src/lib/settings.tsx`、`src-tauri/src/agent.rs` |
| 测试 | Rust 单元测试；前端有翻译分割脚本；没有发现 Vitest/Playwright 集成测试配置 | `src-tauri/src/*.rs`、`scripts/test-translate-split.mjs`、`package.json` |

前端根入口 `src/App.tsx` 负责恢复工作区、窗口级快捷键、托盘关闭流程、应用助手邮箱轮询和工作区实例装配。`src/components/WorkspacePane.tsx` 以工作区 ID 保持实例挂载，非当前工作区通过 `visible` 隐藏，因此切换工作区不会卸载终端、Monaco model 或右栏工具。

后端入口 `src-tauri/src/lib.rs` 注册所有 Tauri command 并管理全局 state。退出时统一清理 PTY、Agent、目录监听、远程连接、数据库连接、预览进程和 CICD 子进程（`src-tauri/src/lib.rs:242-275`）。

## 3. 模块与调用链

### 3.1 工作区与文件访问

1. `App.tsx` 从 `localStorage` 读取工作区列表，调用 `workspaceActivate(roots)`。
2. `src-tauri/src/fs_api.rs::workspace_activate` 检查根目录、canonicalize、登记到 `FsState.known`，放行 Tauri asset scope，并替换当前目录监听。
3. 前端每次文件/Git/搜索调用都显式传 `root`；后端先通过 `FsState::checked_root` 检查根是否已登记，再由 `resolve` 进行路径归一化和边界校验。
4. `workspace_close` 会清理该根的 Agent、预览 Agent、PTY，停止监听并移除白名单。

文件边界是现有最重要的安全约束：已存在路径会 canonicalize 以阻断软链接逃逸；不存在的尾部路径会基于最近存在的祖先拼接，并最终检查仍在根内（`src-tauri/src/fs_api.rs:134-175`）。写文件使用同目录临时文件加 rename 的原子写入（`src-tauri/src/fs_api.rs:789-829`）。

### 3.2 PTY / Native Terminal

调用链为：

```text
TerminalPane
  -> src/lib/pty.ts::spawnPty
  -> invoke("pty_spawn") + Tauri Channel<PtyEvent>
  -> src-tauri/src/pty.rs::open_shell / pty_spawn
  -> portable-pty ConPTY 或平台原生 PTY
  -> reader thread: base64 Data
  -> waiter thread: Exit(code)
  -> xterm.js 渲染
```

`PtyState` 用进程内 `HashMap<u32, PtySession>` 管理会话，记录会话归属工作区 root。支持 spawn、write、resize、kill；子进程退出后发送退出码并从池中移除。`kill_workspace` 和 `kill_all` 分别用于关闭工作区和应用退出。

现有测试 `src-tauri/src/pty.rs::shell_roundtrip_through_pty` 会启动真实 shell、写入命令、读取输出并验证往返，说明 PTY 底座已有离线可重复的基础回归。但目前 PTY 事件只表示原始字节和退出，不包含 Agent、Session、Run、Task 或结构化工具事件。

### 3.3 Agent 与会话

`src-tauri/src/agent.rs` 的 `AgentState` 按工作区 root 保存 opencode 子进程 slot。`agent_start` 生成隔离配置目录和端口，探测 opencode v1/v2 协议，启动 SSE 事件泵和退出监控；随后通过 `agent_create_session`、`agent_send`、`agent_abort`、`agent_list_sessions` 等命令操作原生会话。

前端 `src/lib/agent.ts`、`src/lib/agent-session.tsx` 和 `src/components/AgentPane.tsx` 负责会话列表、消息流、标题和当前工作区的会话 UI。原生会话历史主要由 opencode 的数据库维护；Codovo 前端保存的是当前窗口/工作区的会话关联状态，而不是统一的平台 Session 表。

应用助手和预览助手不是直接让子进程改前端状态：MCP 子进程写请求文件，前端 `App.tsx` 轮询 `takeAppAgentRequest` / `takePreviewAgentRequest`，执行后再写回响应。这是未来平台事件或审批桥接时需要复用的现有模式。

### 3.4 Git、Worktree 与变更

`src-tauri/src/git.rs` 是一个较完整的 Git command 层，已有：

- 状态、文件级和 hunk 级 diff、暂存/取消暂存/放弃修改；
- commit、amend、撤销上次提交、提交历史、文件统计；
- branch、tag、stash、fetch/pull/push、merge/冲突处理；
- Git worktree 清单、prune、状态；
- `workstream_*` 工作树审查、创建、合并和移除。

前端 `src/lib/git.ts` 将这些命令包装成 controller，`WorkspacePane` 按工作区根维护 Git 目标和工作树状态，`ChangesRadarPane` 展示主检出与工作树的状态雷达，`GitChangesPane` 承载暂存、提交和历史操作。

现有 Worktree 能力可以成为 CODO-207 的复用基础，但当前 Git 变更没有记录“由哪个 Task Run 产生”或 baseline/final 快照；工作树归属仍是界面选择和实时状态。

### 3.5 预览、远程、数据库和部署

- `preview.rs` 按工作区管理探测结果和 dev server 子进程，支持 detect/start/stop/status，退出应用统一清理。
- `remote.rs` 管理 SSH 交互终端、SFTP 列表、上传、下载和文件操作；凭据通过 `secrets.rs` 使用系统凭据库。
- `database.rs` 管理 MySQL/PostgreSQL/SQLite 连接池、数据库元数据、查询和 Excel/CSV 导出；数据库 Agent 由 `db_agent.rs` 驱动，并限制为只读。
- `cicd.rs` 读取项目根 `.local-cicd.yaml`，执行 Preflight/Build/Deploy/Verify，必要时 Rollback，并以工作区 root 分片保存进程状态。

这些模块都是现有产品能力，但它们的运行状态尚未归一到统一 Event Store，也没有和 Task Run 关联。

## 4. 已有能力与 PRD 对照

| PRD 能力 | 当前状态 | 说明 |
| --- | --- | --- |
| FR-004 PTY 保底模式 | 已有 | 真实 shell、输入、resize、退出码已实现；不是统一 Agent Adapter |
| FR-010 原生 Session 映射 | 部分 | opencode session 可列出/创建/恢复历史；没有 Codovo Session 持久化实体 |
| FR-011 启动/输入/取消/停止 | 部分 | PTY 和 opencode 两条路径各自实现；状态语义未统一 |
| FR-012 流式事件 | 部分 | PTY 原始输出与 opencode SSE 存在；无统一序号、幂等键、可信来源和 Event Store |
| FR-040 Project/Repository | 缺失 | 工作区可包含多个目录，但没有 Project/Repository 领域表 |
| FR-041 任务工作树关联 | 部分 | Worktree 可创建/查看/合并；没有 Task/Run 归属 |
| FR-042 Worktree 租约与安全回收 | 部分 | 有 worktree 操作和 dirty 状态；没有平台所有权、租约和确认策略 |
| FR-043 Run 与 Git 快照 | 缺失 | Git 状态实时查询，没有 baseline/final 证据记录 |
| FR-053 标准 Event Store | 缺失 | 事件分散在 Channel、SSE、前端 stores 和日志中 |
| FR-055 日志隐私 | 部分 | 密钥进系统凭据库；统一日志留存/脱敏/诊断包尚未建立 |
| FR-020 手工 Goal/Task | 缺失 | 当前没有任务看板、任务 API 或任务存储 |
| FR-030 Task/Run 分离 | 缺失 | 终端标签和 Agent session 不能替代 Task/Run |
| FR-034 验收记录 | 缺失 | Git 操作、构建和部署状态没有统一人工验收实体 |

## 5. 持久化与数据边界

当前没有 Codovo 自有 SQLite 数据库或 migration 目录。`sqlx` 依赖用于用户连接的 MySQL/PostgreSQL/SQLite 查询，不是平台元数据存储。需要特别区分：

1. `src/lib/workspaces.ts`：工作区列表和最近工作区 ID 使用 `localStorage`，并支持从旧 `codovo.projects` / 单根工作区格式迁移。
2. `src/lib/session.ts`：编辑器标签、激活项等窗口会话使用浏览器存储；未命名缓冲区和 Monaco 内部状态并非平台任务数据。
3. `src/lib/settings.tsx`：设置使用浏览器存储，敏感凭据由 Tauri `secrets.rs` 进入系统凭据库。
4. `agent.rs`：opencode 原生会话库按配置目录/工作区维护；Codovo 通过 HTTP/SSE 读取和操作，不拥有其内部 schema。

CODO-107 应新增独立的平台存储边界，不把现有用户数据库连接池或 opencode 数据库当作平台数据库。迁移至少需要覆盖 Registry/Session/Event；CODO-201 之后再扩展 Goal/Task/Run/Proposal。

## 6. 测试与开发基线

### 已发现的验证入口

| 命令 | 用途 | 当前依据 |
| --- | --- | --- |
| `pnpm build` | 生成文件图标、TypeScript 检查、Vite 构建 | `package.json`、`AGENTS.md` |
| `cd src-tauri && cargo test --lib` | Rust 单元测试 | `README.md`、`AGENTS.md` |
| `cd src-tauri && cargo clippy` | Rust 静态检查 | `README.md`、`AGENTS.md` |
| `pnpm test:translate` | 翻译分段脚本测试 | `package.json`、`scripts/test-translate-split.mjs` |
| `node scripts/cdp-check.cjs ...` | WebView2 CDP 界面验证 | `README.md`、`scripts/cdp-check.cjs` |

Rust 模块已有较多纯函数和行为测试，尤其是 PTY、路径沙箱、编码、Git 解析、Agent 配置生成等。没有发现前端测试 runner、端到端测试目录或 Fake Agent fixture。CODO-004 应在不依赖真实模型权限的前提下补充 Fake Adapter/CLI fixture，并记录现有命令的基线输出。

## 7. 主要架构缺口与风险

1. **没有统一领域标识**：PTY id、opencode session id、工作区 id、Git worktree path 各自独立，缺少 `TaskId / RunId / SessionId / EventId` 以及跨模块关联。
2. **没有平台事件账本**：当前事件要么直接推给 UI，要么写进厂商自己的日志/数据库，重启后无法按 Task/Run 回放和核对。
3. **没有任务状态机**：没有 `proposed → pending → ready → running → reviewing → completed` 及非法转换检查，也没有把 Agent 声明、验证结果、人工验收分开。
4. **进程状态是内存状态**：PTY、Agent、预览、远程和 CICD 状态在应用退出时清理；重启后只能恢复部分 UI/原生会话元数据，不能完成平台级状态对账。
5. **工作区和工作树边界需要复用而非复制**：现有 `FsState`、工作区 root 分片和 Git worktree 安全逻辑已经成熟，新领域层必须调用这些入口，避免另造一套路径/权限判断。
6. **Agent 能力探测尚未统一**：当前 Agent 重点是 opencode v1/v2 协议探测；Claude/Codex/CodeBuddy 仍主要通过终端 CLI 运行，没有统一 Registry、版本、认证和能力协议。
7. **测试夹具不足**：真实 PTY 测试不能覆盖 Agent 取消、重复事件、失联、权限请求和重连；后续 Adapter 开发会缺少稳定离线基线。

## 8. 建议实施切入点与顺序

基于实际代码，建议按开发计划调整为：

1. **CODO-001**：先把 `TerminalPane → lib/pty.ts → pty.rs` 的调用链整理成回归说明，补充输入、resize、kill、异常退出的稳定 smoke scenario；保持现有 PTY 接口不变。
2. **CODO-002**：在 `installer.rs` 已有 CLI 检测的基础上，建立 Claude/Codex/OpenCode/CodeBuddy 能力矩阵；终端 CLI 先保持 PTY 降级，不虚构结构化事件。
3. **CODO-003**：冻结领域接口和数据归属 ADR。特别明确平台 DB 与用户数据库工具、Codovo Session 与 Native Session、Task 与 Run 的边界。
4. **CODO-004**：先补 Fake Adapter、Fake CLI 和事件 fixture，再做公共类型；把失败、取消、超时、重复事件、权限拒绝设为契约场景。
5. **CODO-101/102/103**：将 `AgentCapabilities`、错误类型、Registry、Profile 放在 Rust/TypeScript 的薄接口层；复用 `installer::check_agent_clis`，不把设置页面直接当 Registry。
6. **CODO-104/105/106**：以现有 `PtyState` 为兼容实现，新增 Supervisor/Adapter 抽象，并保留 `pty_spawn/write/resize/kill` 作为 L1 PTY 路径。
7. **CODO-107/108/109/110**：建立平台 SQLite migration、Session 映射、Event Envelope/Store 和重启对账；迁移必须不触碰 opencode 原生库和用户数据库连接。
8. **CODO-201 以后**：在 Event/Session 基础上实现 Task/Run/Proposal/Workspace 领域模型，复用现有 Git worktree 和根边界校验，最后再接任务 UI。

## 9. 盘点范围与未验证项

本次盘点为源码和配置静态检查，未启动 Tauri 窗口，也未探测本机是否安装 Claude/Codex/OpenCode/CodeBuddy。CLI 具体版本、认证状态、JSON/Server API 和取消能力属于 CODO-002 的运行时验证范围。没有根据 PRD 参考结构推断不存在的模块；本文件中的“缺失”表示在当前仓库搜索和入口检查中未发现对应实现。

## 10. CODO-000 交付摘要

```yaml
task_id: CODO-000
result: completed
summary: 完成 Codovo 现有 GUI、PTY、Agent、Git、Worktree、文件沙箱、数据库和测试基线盘点
changed_files:
  - docs/codovo-current-state.md
tests: []
decisions:
  - 现有实现是 React + TypeScript / Tauri 2 + Rust 桌面工作台
  - 当前没有 Codovo 自有 Project/Task/Run/Proposal/Event Store 领域层
  - 后续平台存储必须与用户数据库连接和 opencode 原生会话库分离
  - 现有 PTY、FsState 路径沙箱和 Git Worktree 能力作为后续实现基础复用
risks:
  - CLI 版本、认证和结构化接口尚未运行时核实
  - 缺少 Fake Adapter/CLI fixture 和前端集成测试基线
next_tasks:
  - CODO-001
  - CODO-002
  - CODO-003
```
