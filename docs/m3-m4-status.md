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
| CODO-309 | 资源记录包含 scope/digest/conflicts，冲突返回预览数据，不静默覆盖 |
| CODO-310—311 | 协议类型和单测已建立；真实四家 Adapter 的黄金 Fixture/E2E 需在对应 CLI 可用环境补跑 |

## M4

| 任务 | 当前交付 |
| --- | --- |
| CODO-401 | `ProposalSource` 统一 Manual/Conversation/Agent/Planner/Import/Execution 来源 |
| CODO-402 | PlannerPlan schema、标题/验收校验和 DAG 环检测 |
| CODO-403 | 标题规范化去重；默认 Manual 策略，AutonomousLimited 需显式策略 |
| CODO-404 | 原生任务映射保留为候选来源，不把不可观察能力标成已发现 |
| CODO-405—406 | HandoffPackage 明确证据可信度与跨 Agent 不保留 native session 的事实 |
| CODO-407 | ready 队列按 `maxConcurrent` 限流，策略包含重试/超时/预算字段 |
| CODO-408 | Verifier 失败不宣称成功，可派生待审批修复 Proposal |
| CODO-409—410 | Planner/Developer/Reviewer/Verifier 角色与工作台数据契约已冻结；现有设置页仍是基础入口 |
| CODO-411 | 纯领域 DAG/Verifier 测试已建立；完整多进程故障注入需 Rust 依赖环境恢复后执行 |

## 验证与边界

- `pnpm.cmd exec tsc --noEmit`：通过。
- 新增 Rust 文件 `rustfmt --edition 2021 --check`：通过。
- `cargo test --lib`：本机 `aws-lc-sys` 的 MSVC `cl.exe D8050` 阻断依赖编译，无法在当前环境取得 Rust 测试证据。
- M3/M4 契约层不会伪造真实厂商能力；真实 Adapter 接入、网络重连和黄金 Fixture 仍以 `docs/agent-compatibility-matrix.md` 的版本探测结果为准。
