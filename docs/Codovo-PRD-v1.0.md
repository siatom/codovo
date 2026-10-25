# Codovo 码坞 — 多 Coding Agent 统一管理平台产品需求文档（PRD）

> 版本：v1.0 · 日期：2026-10-24 · 状态：研发基线草案  
> 读者：产品负责人、架构师、前后端开发 Agent、测试 Agent  
> 关联文档：[技术设计](./Codovo-Architecture-v1.0.md) · [开发计划与任务包](./Codovo-Development-Plan-v1.0.md)

## 0. 文档约束与决策状态

**已确定的产品方向**：保留各厂商原生 Coding Agent 内核；Codovo 负责跨 Agent 的项目、任务、工作区、运行、配置、权限和执行观察；保留 xterm.js 原生终端；以 `Task` 而非 `Session` 作为可持续工作的中心。

**待仓库核实的技术假设**：现有 Codovo 可能采用 Tauri/Rust + TypeScript 桌面架构。本 PRD 不声明已经采用该技术栈，也不声明现有代码具备本文的模块。Coding Agent 在实现前必须先检查仓库、框架版本、数据库、终端实现和各 CLI 当前可用接口，并提交兼容性评估。

**文档优先级**：产品约束与验收标准 > 技术设计示例 > 代码实现细节。各厂商 CLI/SDK 不同版本的行为以运行时能力探测和官方文档为准。

## 1. 背景与问题

Codovo 当前主要将 Claude Code、Codex、CodeBuddy、OpenCode 等 CLI 通过 xterm.js + 原生终端方式纳入同一 GUI。用户在不同终端启动和操作 Agent，但安装、配置、会话、计划、工具权限、工作目录、产出验收仍由各 Agent 独立处理，Codovo 很难理解执行进度和管理协作。

主要问题：

1. **控制缺位**：只能可靠掌握终端/进程状态，缺乏统一的 Agent 结构化事件与审批入口。
2. **会话孤岛**：原生 Session ID、上下文、会话恢复机制各异，难以搜索、接续与交接。
3. **任务孤岛**：用户需求、Agent Todo、Subagent 子任务混杂在对话内，无法跨会话、跨 Agent 持续管理。
4. **工作区冲突**：多个 Agent 可能写入同一工作树；Git 变更、分支、Worktree 与任务归属不清。
5. **配置分散**：Skills、MCP、Rules、Hooks、模型、启动参数和权限策略多处维护。
6. **结果不可信**：Agent 声称完成不等于测试、审查和验收通过。

## 2. 产品定位、目标与边界

**定位**：Codovo 是 AI Native Coding GUI 和多 Coding Agent 控制平台，不是另一个独立基础 Coding Agent。

### 2.1 产品目标

| ID | 目标 | 可验收描述 |
|---|---|---|
| G-01 | 统一接入 | 至少对四种目标 Agent 建立可探测的 Adapter，并保留 PTY 兼容模式 |
| G-02 | 统一会话 | 在 GUI 中列出、启动、停止、关联并在受支持情况下恢复原生会话 |
| G-03 | 统一任务 | 一个 Task 可跨多个 Run、Session、Agent 和应用重启持续存在 |
| G-04 | 任务生成 | 支持手工、对话、Agent 提议、外部计划、执行反馈五种来源 |
| G-05 | 工作区安全 | 同仓库并发写任务推荐隔离 Worktree，显示冲突与执行上下文 |
| G-06 | 可观察与可验收 | 事件、代码变更、测试结果、人工确认分别持久化并可追溯 |
| G-07 | 可扩展编排 | 先支持人工和托管执行，再支持依赖调度、任务交接与有限重试 |

### 2.2 非目标

- 不重写 Claude Code / Codex / OpenCode / CodeBuddy 的模型调用、内部规划或工具执行器。
- 不承诺不同 Agent 的完整原生 Session 上下文可互相导入。
- 不将每条聊天消息、每个内部 Todo 都强制转为正式任务。
- 不要求不同 Agent 的 Skills、MCP、Hooks 文件格式完全统一。
- 第一阶段不建设云端多人实时协作、远程集群调度、账单系统或自进化 Agent。
- 不通过猜测终端字符流伪装成可靠的工具调用授权或结构化状态。

## 3. 用户与核心场景

| 角色 | 核心需求 | 场景 |
|---|---|---|
| 独立开发者 | 保留各家 CLI 习惯，同时跨会话持续开发 | 一天使用 Claude 规划、Codex 编码、OpenCode 调整界面 |
| 多 Agent 项目负责人 | 规划、分配、并行和验收 | 完整桌面应用开发持续数周 |
| 技术负责人/审查者 | 对任务修改和测试形成可追溯证据 | 某个任务涉及三个工作树和两个代理运行 |
| 高级用户 | 对模型、CLI、Skills、MCP 和权限保持可控 | 不同项目使用不同 Agent Profile |

### 3.1 关键用户旅程

**S1：延续既有自由对话**。用户在原生终端向 Claude 提问；Codovo 维持 PTY；用户点“将当前工作纳入任务管理”后，系统建立 Task Proposal 并关联原生会话、工作区和可核实事件；确认后产生正式 Task。不承诺补齐已丢失的对话和内部任务。

**S2：从对话自动发现工程任务**。用户在统一聊天中提出“实现模糊搜索”；Codovo 依据消息和事件生成候选，识别为工程任务；根据模式进入待确认或自动登记。普通解释性问答默认不建任务。

**S3：Goal 规划执行**。用户提出“实现 Vorydex MVP”；选择 Planner Agent；系统获得结构化任务提案、依赖、验收标准；用户审阅后批准；任务按依赖进入 Ready 并分配 Agent。

**S4：Agent 派生任务**。开发 Agent 发现未实现的接口阻塞当前任务，向 Codovo 提交 Proposal；平台去重、权限检查、依赖校验，批准后可将其安排给另一 Agent。

**S5：跨 Agent 交接**。Codex 因失败/上下文限制停止；系统保留 Task 和 Run，生成 Handoff Package（含源码 Git 状态、已验证测试、未完成事项和原生会话引用）；用户选择 Claude 接管，新建 Run；旧 Session 不被伪装成已迁移。

**S6：并行开发和审查**。两个编码任务在独立 Worktree 工作；第三个审查任务只读查看差异；每个 Task 记录变更、检查结果、验收决定。

## 4. 核心术语与对象定义

| 对象 | 定义 | 是否归 Codovo 管理 | 生命周期 |
|---|---|---|---|
| Project | 逻辑产品/工程集合 | 是 | 长期 |
| Repository | Git 仓库 | 索引与关联 | 长期 |
| Workspace | 当前可访问的一组工作目录 | 是 | 长期/临时 |
| Worktree | Git 实际工作树 | 创建、归属、清理 | 随任务 |
| Goal | 用户意图中的阶段性或长期目标 | 是 | 天—月 |
| Milestone | 目标阶段 | 是 | 小时—周 |
| Task Proposal | 尚未批准的任务候选 | 是 | 待评审 |
| Task | 可独立分配、交接、验收的正式工作单元 | 是 | 跨 Session |
| Task Run | 对某 Task 的一次执行尝试 | 是 | 单次执行 |
| Codovo Session | 平台级会话记录 | 是 | 跨运行 |
| Native Session | 厂商原生会话/Thread | 厂商所有，平台映射 | 依厂商 |
| Native Task | 原生 Todo/Plan/Subagent 工作 | 厂商所有，平台观察 | 依原生 Session |
| Agent Profile | CLI + 配置 + 运行权限的可选实例配置 | 是 | 长期 |
| Execution Event | 可追踪的运行事件 | 是 | 追加记录 |
| Handoff Package | 跨执行尝试的结构化交接信息 | 是 | 随 Run |

**重要区分**：Task != Run != Session != Native Task。一个 Task 可对应多个 Run；一个 Run 至少绑定一个主原生会话引用；同一 Run 内是否包含子会话取决于 Adapter。不同原生会话不可仅通过复制对话历史就被视为同一个会话。

## 5. 产品信息架构与页面

导航：`Workspace` / `Tasks` / `Agents` / `Changes` / `Settings`。底部可停靠 `Terminal` / `Events` / `Problems`。

| 页面 | 主区 | 侧栏/检查器 | MVP 要求 |
|---|---|---|---|
| Workspace | 项目与仓库树、文件工作区 | Worktree/分支/锁/目录信息 | 必须 |
| Tasks | Goal 列表、看板、依赖、任务详情 | Proposal 审批、Run、验收记录 | 必须 |
| Agents | 安装列表、Profile、Session | 能力等级、版本、认证状态 | 必须 |
| Unified Chat | 流式消息、工具事件、审批请求 | Task、Run、当前 Agent 和上下文 | 分阶段 |
| Native Terminal | xterm.js 原生终端 | 进程/工作目录/Session 关联 | 必须保留 |
| Changes | Commit、Diff、文件变更、冲突 | Task/Run 归属、Review | 必须 |
| Settings | MCP/Skills/Rules/Agent/权限策略 | 配置来源和差异 | 分阶段 |

页面行为要求：明确区分 `Running`、`Waiting for input`、`Detached`、`Turn completed`、`Run completed`、`Task completed`。Agent 能力不可用时显示原因，不提供假按钮。

## 6. 功能需求（FR）

### 6.1 Agent Registry / Adapter

| ID | 需求 | 优先级 | 验收标准 |
|---|---|---|---|
| FR-001 | 自动发现已安装 Agent 的 CLI 路径、版本与基本可用性 | P0 | 命令不存在、版本不兼容、认证未就绪均有可读状态 |
| FR-002 | 支持多个 Agent Profile | P0 | 相同 CLI 可配置不同启动参数/环境变量/工作目录 |
| FR-003 | 统一能力协商 `AgentCapabilities` | P0 | 功能按照探测结果启用/禁用，未知能力按不支持处理 |
| FR-004 | 支持 PTY 保底模式 | P0 | 既有终端功能未回退，Ctrl+C/终端尺寸/退出码可处理 |
| FR-005 | 结构化集成 Claude/Codex/OpenCode/CodeBuddy | P1 | 每个 Adapter 有官方接口映射、版本兼容测试和降级路径 |
| FR-006 | 可检测 Adapter 失联和重复连接 | P0 | 不重复启动不可安全多附着的同一个 Native Session |

### 6.2 会话与 Runtime

| ID | 需求 | 优先级 | 验收标准 |
|---|---|---|---|
| FR-010 | Session 记录与 Native Session ID 映射 | P0 | 关闭应用后仍可查看元数据；可恢复性按能力标注 |
| FR-011 | 启动、输入、取消、停止、状态查询 | P0 | 每种操作有成功/失败/超时反馈，停止不等于任务完成 |
| FR-012 | 流式事件与原始日志 | P0 | 事件有时间、来源、序号、Run/Session 关联与去重键 |
| FR-013 | 支持非结构化会话人工转托管 | P1 | 可创建任务提案但不虚构已执行进度 |
| FR-014 | 异常重启后状态对账 | P1 | 存在但不可附着的进程显示 `unknown/detached`，不自动声称运行中 |

### 6.3 任务产生与正式登记

| ID | 需求 | 优先级 | 验收标准 |
|---|---|---|---|
| FR-020 | 用户手工创建 Goal/Task | P0 | 支持标题、描述、验收标准、仓库、优先级、依赖 |
| FR-021 | 从会话对话生成 Task Proposal | P1 | 普通问答可跳过；能查看来源与引用原文 |
| FR-022 | Planner Agent 生成结构化任务提案 | P1 | Schema 校验、依赖环检测、预览和人工编辑 |
| FR-023 | Agent 执行过程中新增/拆分/派生 Proposal | P1 | 保留父任务、提出者、原因、证据及建议依赖 |
| FR-024 | 从 PRD / Markdown / Issue 导入任务 | P2 | 创建候选而不是未经审查自动执行 |
| FR-025 | Task Proposal 的批准、拒绝、合并、修改 | P0 | 记录操作者、策略、时间和变更快照 |
| FR-026 | 去重与候选关联 | P1 | 语义相似仅提示；任务合并前必须验证实体和依赖 |
| FR-027 | 任务创建策略 | P1 | 手动/辅助/有限自主三模式，有数量、层级及预算限制 |
| FR-028 | Native Task 发现与映射 | P2 | 有来源可信度，原生 Todo 不自动等价为正式 Task |

### 6.4 Task / Run / 调度

| ID | 需求 | 优先级 | 验收标准 |
|---|---|---|---|
| FR-030 | Task 与 Run 分离 | P0 | Task 可以有多次 Run 且各自保留日志与结果 |
| FR-031 | 任务依赖与状态机 | P0 | 非法转换被拒绝；有依赖阻塞时不可自动 Ready |
| FR-032 | 手动指派 Agent 和执行工作区 | P0 | Run 持久化 Profile、环境、Worktree、起止时间 |
| FR-033 | 托管执行与状态追踪 | P1 | Agent Turn 完成不会自动标记 Task 完成 |
| FR-034 | 执行结果与验收 | P1 | 声明完成、自动检查、用户验收单独记录 |
| FR-035 | Run 失败后重新执行/转派 | P1 | 新 Run 关联上次 Handoff，不覆盖历史证据 |
| FR-036 | 依赖任务调度、并行、预算限制 | P2 | 并行数、超时、重试上限可配置并强制执行 |
| FR-037 | Planner—Developer—Verifier—Reviewer 工作流 | P2 | 每步有契约和退出条件；失败时进入有限重试/待人处理 |

### 6.5 Workspace / Git / 变更

| ID | 需求 | 优先级 | 验收标准 |
|---|---|---|---|
| FR-040 | Project 关联多 Repository | P0 | 各 Repo 路径、默认分支、权限可单独维护 |
| FR-041 | 任务关联一个或多个工作树 | P0 | 可区分单仓库/跨仓库执行上下文 |
| FR-042 | Worktree 创建、清单、锁、回收 | P1 | 只删除平台创建且确认无用户变更的资源；默认不自动清理 |
| FR-043 | 变更与 Task Run 关联 | P1 | 记录起止 Git 快照和变更文件；并发写入显示归属不确定 |
| FR-044 | Git Diff/Commit/测试结果检查器 | P1 | 可从 Task 追溯变更、审查、测试和提交 |
| FR-045 | 冲突与共享写入预警 | P1 | 同一工作树并行写任务有明显提示或策略阻止 |

### 6.6 权限、资源与可观察性

| ID | 需求 | 优先级 | 验收标准 |
|---|---|---|---|
| FR-050 | 外层执行权限 Profile | P1 | 工作目录、网络、命令、时长边界可配置；无法强制时明确标示 |
| FR-051 | Agent 原生审批能力接入 | P1 | 仅在官方支持回调/Hook 时提供统一审批；其余保留原生流程 |
| FR-052 | MCP/Skills/Rules 登记与适配分发 | P2 | 不覆盖原生用户配置；展示生效来源与冲突 |
| FR-053 | 标准化 Event Store | P0 | 原生/外部观察/推断三种可信来源区分 |
| FR-054 | 执行时间线与错误诊断 | P1 | 事件可按 Agent、Task、Run、Session 过滤 |
| FR-055 | 日志隐私及敏感信息处理 | P0 | 默认不持久化密钥；日志可设置留存、脱敏和清理 |

## 7. 任务业务规则

### 7.1 五个入口与默认行为

| 来源 | 提交物 | 默认结果 | 自动入库条件 |
|---|---|---|---|
| 用户手工创建 | 表单 | 正式 Task | 直接创建 |
| 用户自然语言对话 | 对话证据 | Proposal | 用户确认或已启用受控自动规则 |
| Agent Plan / Todo | 结构化计划或声明 | Proposal / NativeTaskLink | 规则允许且可独立验收 |
| PRD / Issue / 导入 | 外部资源 | Proposal | 明确的批量批准 |
| 测试/审查/执行失败 | 检查证据 | Proposal | 受控的小范围修复任务可按策略批准 |

### 7.2 什么应成为正式 Task

- 有明确、可验证的交付结果；能独立失败或成功；能指派 Agent/Run；能记录验收。
- “打开文件”“搜索代码”“执行单次命令”等普通工具步骤默认不是 Task。
- 内部 Todo 可以作为一个平台 Task 的可观察步骤，也可以经提升形成独立 Task；不得根据文本标题一对一复制。
- 任务拆分应满足规模合理性；同目标候选优先查重并关联，禁止无边界自动递归拆分。

### 7.3 状态与完成判定

Task：`proposed`（仅候选对象）→ `pending` → `ready` → `running` → `reviewing` → `completed`；还包括 `blocked`、`failed`、`cancelled`。正式 Task 不以 `proposed` 起始，Proposal 有独立状态。具体合法转换见技术设计。

Run：`queued`、`starting`、`running`、`waiting_input`、`cancelling`、`succeeded`、`failed`、`cancelled`、`interrupted`、`unknown`。

完成判定使用独立信号：

1. `agent_claim`：Agent 自述完成，不等于验收；
2. `verification`：构建/测试/静态检查及输出证据；
3. `acceptance`：规则或人工审批的正式结论。

MVP 默认要求明确的人工验收才能 `completed`；后续允许用户为低风险任务配置可审计自动验收。

### 7.4 Handoff 规则

- 包含：目标、验收标准、已做工作、剩余工作、决策、已执行命令、检查结果、Git base/head/dirty 状态、涉及路径、风险与原生 Session 引用。
- 对每项标记 `reported_by_agent` / `observed_by_codovo` / `verified_by_check`。
- 严禁把失败摘要当成执行事实；新 Agent 启动时明确告知需要核验的内容。

## 8. 默认权限与自动化策略

| 策略 | 提议 | 正式创建 | 自动执行 | 适用 |
|---|---|---|---|---|
| Manual | 允许 | 用户批准 | 用户启动 | 严格项目 |
| Assisted（默认） | 允许 | 仅低风险限定规则可自动登记 | 用户授权的 Task 可托管 | 日常开发 |
| Autonomous Limited | 允许 | 在范围、深度、数量、时长预算内 | 可按规则调度 | 已明确风险边界的工作流 |

永不因为选择 Autonomous Limited 而自动授予突破沙箱的权限。Git 强制推送、跨项目目录删除、修改安全凭据等高风险操作需要独立控制和适当确认。

## 9. 非功能需求

| 类别 | 要求及初始验收门槛 |
|---|---|
| 平台 | 优先支持 Codovo 既有桌面平台；Windows 是重要目标，兼顾未来 macOS/Linux |
| 稳定性 | Agent 进程异常退出不会破坏 Task/Run 历史；重启后恢复元数据并进行状态对账 |
| 响应 | 本地列表常见操作目标 P95 < 300ms；事件到 GUI 显示目标 P95 < 500ms（本地连接、非网络延迟） |
| 可靠性 | Event Store 追加写入支持幂等；中断后不得将失败执行写成成功 |
| 数据规模 | MVP 以 100 项目、10 万事件、1 万 Task 进行测试，性能基线需实际测量 |
| 安全 | 默认最小权限；凭据不进入日志；命令输出渲染防注入；外部链接/文件操作需要边界验证 |
| 兼容性 | 不破坏现有 xterm.js 终端；Adapter 不可用时可回退 PTY，并提示能力降低 |
| 可诊断性 | 每次 Run 可导出脱敏诊断包，含事件、退出码、错误、版本信息和追踪 ID |
| 可维护性 | 核心模块以接口分离；数据库 Migration 可回滚或提供明确兼容策略 |

## 10. MVP / 版本边界

**MVP（P1+P2 基础）**：CLI Registry、PTY Runtime、Session 元数据、Event Store、Project/Repo/Workspace、Goal/Task/Run/Proposal、基础任务看板、手动任务执行、Git 基线快照、日志/异常对账。

**Beta（P3）**：四家 Agent 深度 Adapter 的可用能力、统一聊天、任务候选识别、Planner 提案、权限回调（条件支持）、配置目录。

**Advanced（P4）**：Handoff、自动验证、依赖调度、限定并行、Reviewer 工作流、有限自动修复循环、任务来源智能去重建议。

## 11. 跨模块端到端验收用例

| ID | 场景 | 预期结果 |
|---|---|---|
| E2E-01 | 启动 Claude PTY 并关闭重开 Codovo | 终端兼容；Session 元数据存在；进程状态重新核对 |
| E2E-02 | 输入“解释函数” | 不自动生成正式任务 |
| E2E-03 | 输入“实现搜索功能并测试” | 提示任务候选，保留源消息和 Agent 关联 |
| E2E-04 | Agent 发现缺失接口 | 提交派生 Proposal；批准后建立依赖，不直接越权执行 |
| E2E-05 | 同一 Task 第一次执行失败、第二次由不同 Agent 完成 | 1 个 Task、2 个 Run、各自 Session 与日志不覆盖 |
| E2E-06 | Agent 回复“完成”，测试失败 | Task 不进入 Completed，形成 Verification Fail |
| E2E-07 | 两 Agent 同仓库并发开发 | 创建或提示独立 Worktree；共享写入产生风险提示 |
| E2E-08 | 模拟 CLI 不支持 JSON 输出 | 显示 PTY 降级、停止虚假工具事件和统一审批 |
| E2E-09 | CLI 在工具调用中崩溃 | Run 标记 interrupted/failed，Task 保留，允许重试 |
| E2E-10 | 重复 Proposal 标题相近、验收标准不同 | 提示可能相关但不强行合并 |
| E2E-11 | 修改已有厂商配置文件 | 只读导入/差异预览，不静默覆盖 |
| E2E-12 | 在自主模式反复失败 | 达到重试/耗时上限即停止并请求人工处理 |

## 12. 产品指标

首版上线后建议统计（默认尊重本地隐私，仅本地分析；遥测需单独征得同意）：

- Agent 启动成功率、Adapter 降级率、恢复成功率。
- 用户主动创建的正式任务数、Proposal 接受率和误报率。
- Run 可追溯率（关联 Agent、Session、Workspace、退出结果）。
- Task 验收完成率、失败重试率、交接后继续完成率。
- 并行 Worktree 冲突率与测试通过率。

## 13. 待产品负责人确认事项

1. 现有 Codovo 前后端技术栈、数据库和模块边界，以仓库扫描结果为准。
2. 首个目标操作系统是仅 Windows，还是 Windows/macOS/Linux 同步支持。
3. 默认任务生成策略暂定 Assisted；是否在 MVP 提供自动识别，还是先提供“转换为任务”。
4. 是否允许 Codovo 修改原生 Agent 配置文件，默认建议禁止覆盖并采用显式预览。
5. 正式 Task 的自动验收范围，默认建议 MVP 只允许人工确认。
6. 远程执行、多人共享、CI/CD 双向同步是否进入后续版本。

## 14. 实施说明

PRD 中的功能编号、产品模型和验收用例是编码任务的唯一需求追踪入口。开发 Agent 应引用 `FR-xxx` 和 `E2E-xx`，不得只根据聊天摘要扩展需求。开发顺序、任务粒度与 Agent 操作协议见《Codovo 开发计划与任务包》。
