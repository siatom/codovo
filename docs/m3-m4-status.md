# M3 / M4 深度接入与长程编排状态

本阶段先冻结跨 Agent 的协议和编排边界，再接入厂商 SDK/Server。实现位于 `src-tauri/src/agent_protocol.rs`、`src-tauri/src/orchestration.rs`，前端薄封装位于 `src/lib/agent-protocol.ts` 和 `src/lib/orchestration.ts`。

## M3

| 任务 | 当前交付 |
| --- | --- |
| CODO-301 | 统一 `StructuredMessage`、`ToolCard`、`ApprovalRequest`、`EvidenceSource`、`NormalizedAgentEvent` |
| CODO-302—305 | 适配器无关的事件归一、能力/权限边界已冻结；真实 Codex/OpenCode/Claude/CodeBuddy SDK 连接器仍需按版本矩阵接入 |
| CODO-306 | 协议层允许结构化聊天与 PTY 分离共存，未知能力不会热切换为原生模式 |
| CODO-307 | M2 `proposal_from_session` 提供会话转候选保底路径；结构化消息可携带 citations |
| CODO-308 | 审批桥只允许 approved/rejected/timed_out 终态，pending 不能被伪造为执行完成 |
| CODO-309 | `protocol_index_workspace_resources` 索引 `.codovo/{rules,memory,skills,agents}`，输出 scope/digest/conflicts；冲突返回预览数据，不静默覆盖 |
| CODO-310—311 | `protocol_sanitize_diagnostics` 递归脱敏 token/secret/password/API key；真实四家 Adapter 的黄金 Fixture/E2E 需在对应 CLI 可用环境补跑 |

## M4

| 任务 | 当前交付 |
| --- | --- |
| CODO-401 | `ProposalSource` 统一 Manual/Conversation/Agent/Planner/Import/Execution 来源 |
| CODO-402 | PlannerPlan schema、标题/验收校验和 DAG 环检测 |
| CODO-403 | 标题规范化去重；默认 Manual 策略，AutonomousLimited 需显式策略 |
| CODO-404 | 原生任务映射保留为候选来源，不把不可观察能力标成已发现 |
| CODO-405—406 | HandoffPackage 明确证据可信度与跨 Agent 不保留 native session 的事实 |
| CODO-407 | ready 队列按 `maxConcurrent` 限流，策略包含重试/超时/预算字段；Planner Plan 与策略持久化到 `orchestration_plans`，可重启恢复 |
| CODO-408 | Verifier 失败不宣称成功，可派生待审批修复 Proposal |
| CODO-409—410 | Planner/Developer/Reviewer/Verifier 角色与工作台数据契约已冻结；现有设置页仍是基础入口 |
| CODO-411 | 纯领域 DAG/Verifier 测试已建立；完整多进程故障注入需 Rust 依赖环境恢复后执行 |

## 验证与边界

- `pnpm.cmd exec tsc --noEmit`：通过。
- `pnpm.cmd test:adapter-contracts`：通过，离线检查四家 CLI 的只读帮助入口与结构化线索。
- `pnpm.cmd test:m3-m4`：通过，验证 Fake Agent 审批拒绝/失败事件链、幂等 eventKey 和 Planner 依赖推进。
- 新增 Rust 文件 `rustfmt --edition 2021 --check`：通过。
- `cargo test --lib`：本机 `aws-lc-sys` 的 MSVC `cl.exe D8050` 阻断依赖编译，无法在当前环境取得 Rust 测试证据。
- M3/M4 契约层不会伪造真实厂商能力；真实 Adapter 接入、网络重连和黄金 Fixture 仍以 `docs/agent-compatibility-matrix.md` 的版本探测结果为准。

四家 Agent 现在都有显式 `AdapterDescriptor`（`src-tauri/src/adapters.rs`）：默认只声明流式文本/交互回合，原生能力必须由探测结果显式开启；审批策略为 `native_only_else_pty`，未知能力回退既有 PTY，不启用危险免审批参数。

本机 2026-10-24 的只读帮助探测还确认：Codex `exec --output-format stream-json`、OpenCode `--server/--session`、Claude `--print/--output-format`、CodeBuddy `--print --output-format stream-json` 与 `--serve/--acp`。这些只是 CLI 入口证据，仍不等于模型认证或端到端调用成功。
