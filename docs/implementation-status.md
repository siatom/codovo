# Codovo 实施状态

> 依据 `Codovo-Development-Plan-v1.0.md`，记录已经落地的任务和真实验证证据。

## M0：仓库盘点与架构决策

| 任务 | 状态 | 交付 | 验证 |
| --- | --- | --- | --- |
| CODO-000 | completed | `docs/codovo-current-state.md` | 源码、入口、依赖和测试命令静态盘点 |
| CODO-001 | completed | `docs/codovo-pty-session-flow.md` | PTY 调用链、Session 语义和回归矩阵；已有 Rust roundtrip 用例 |
| CODO-002 | completed | `docs/agent-compatibility-matrix.md` | 四家 CLI 版本/帮助运行时探测；认证保持 unknown |
| CODO-003 | completed | `docs/adr/ADR-001.md` 至 `ADR-008.md` | 8 项 ADR 与切入模块、取舍、后果 |
| CODO-004 | completed | `scripts/fixtures/fake-agent.mjs`、`scripts/test-fake-agent.mjs`、`docs/test-baseline.md` | Fake Adapter 生命周期/故障测试和现有基线命令 |

## M0 之后的修订顺序

1. CODO-101：冻结领域 ID、错误类型、`AgentCapabilities` 和 `NativeHandle`。
2. CODO-102/103：在现有依赖检测和设置基础上建立 Registry/Profile，不保存明文 token。
3. CODO-104/105/106：以现有 `PtyState` 为兼容底座，建立 Runtime Supervisor、PTY Adapter 和 Fake Adapter 契约。
4. CODO-107/108/109/110：新增独立平台 SQLite migration、Session 映射、Event Store 和重启对账。
5. CODO-111/112：再做 Agent/Session 管理 UI 和 M1 回归展示。

## M0 退出判断

- [x] 现有 GUI、后端、终端、Git、数据库和测试入口已识别。
- [x] PTY 启动、resize、stdin/stdout、退出、停止调用链已记录。
- [x] 四家 Agent CLI 的路径和版本已运行时探测；未知能力明确标记。
- [x] 8 项 ADR 已记录备选方案、决定和后果。
- [x] Fake CLI/Adapter 可离线运行，覆盖成功、失败、取消、重复事件和权限请求。
- [x] 前端构建和 Fake Adapter 测试已通过；Rust 基线失败原因已记录为本机 `aws-lc-sys`/MSVC `cl.exe D8050` 环境问题。
- [x] 后续实施顺序和模块复用/新增边界已固定。

## M1：控制面与运行时骨架

M1 的任务映射、SQLite v1 表结构、Tauri 命令、验证证据和已知边界见 [`m1-status.md`](./m1-status.md)。核心实现位于 `src-tauri/src/control_plane.rs` 与 `src-tauri/src/runtime.rs`，原有 PTY 路径保持不变。

## M2：任务管理与工作区

M2 的领域模型、状态机、Proposal、Run、Project/Repository、Worktree 租约和 Verification 记录见 [`m2-status.md`](./m2-status.md)。核心实现位于 `src-tauri/src/task_plane.rs`，前端通过 `src/lib/task-plane.ts` 调用。
