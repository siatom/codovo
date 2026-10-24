# M1 控制面与运行时状态

本文件记录 M1 的实现范围、入口和验证证据。M1 在现有 PTY 链路之上新增控制面与进程运行时，不替换原有 `pty.rs`。

## 交付映射

| 任务 | 实现 | 说明 |
| --- | --- | --- |
| CODO-101 | `src-tauri/src/control_plane.rs` | 领域 ID、错误、`AgentCapabilities`、`NativeHandle`、集成模式 |
| CODO-102 | `control_registry_scan` / `control_registry_list` | 复用 `installer::check_agent_clis`，持久化安装状态与能力边界 |
| CODO-103 | `control_profile_*` | Profile CRUD；环境变量键拒绝 token、secret、password、API key 等敏感字段，凭据不进入 SQLite |
| CODO-104 | `src-tauri/src/runtime.rs` | 独立进程槽、owner、stdout/stderr 事件、取消、停止、超时、应用退出清理 |
| CODO-105 | 既有 `pty.rs` + `fs_api::workspace_close` | 保持 PTY 兼容路径；关闭工作区时按 root 清理运行时进程 |
| CODO-106 | `scripts/fixtures/fake-agent.mjs` | Fake Agent 覆盖成功、失败、取消、重复事件、权限请求；运行时事件契约已统一 |
| CODO-107 | `ControlPlaneState::migrate` | SQLite WAL、外键、schema_migrations、安装/配置/会话/事件表及索引 |
| CODO-108 | `control_session_*` | Session 与 native handle 映射，按工作区 root 查询 |
| CODO-109 | `control_event_record` / `control_event_list` | 事件 envelope、JSON payload、`(adapter_id,event_key)` 幂等键、分页读取 |
| CODO-110 | `control_reconcile` | 启动时将 `starting/running/waiting_input` 标记为 `unknown`，避免重启后伪造仍存活状态 |
| CODO-111 | `src/lib/control-plane.ts`、`SettingsDialog.tsx` | 设置页展示 Registry 安装状态、支持模式和 Native Session；通过薄封装调用 Tauri |
| CODO-112 | `docs/test-baseline.md`、本文件 | 前端构建、Fake Adapter、事件/状态模型和环境阻断均有记录 |

## SQLite v1

数据库位于应用数据目录的 `codovo-control-plane.sqlite3`，迁移创建：

- `schema_migrations`
- `agent_installations`
- `agent_profiles`
- `agent_sessions`
- `execution_events`

所有表包含生成的领域 ID 和时间戳；事件使用 `(adapter_id, event_key)` 唯一约束实现重复投递幂等。数据库启用 WAL 与外键约束。

## Tauri 命令

控制面命令包括 `control_registry_scan`、`control_registry_list`、`control_profile_list`、`control_profile_upsert`、`control_profile_delete`、`control_session_create`、`control_session_list`、`control_session_update_status`、`control_event_record`、`control_event_list` 和 `control_reconcile`。运行时命令包括 `runtime_start`、`runtime_cancel` 与 `runtime_stop`。

## 验证

- `pnpm.cmd build`：通过。
- `node scripts/test-fake-agent.mjs`：通过，覆盖 success/failure/cancel/duplicate/permission。
- `git diff --check`：通过。
- `cargo test --lib`：当前共享目标目录构建已通过；M1/M2/M3/M4 合计 379 个 Rust 单测全部通过。

## 已知边界

M1 的控制面 API 和设置页入口已落地；Native API 适配器、真实凭据库接入、跨平台进程树终止和完整原生 Agent 会话 UI 留给后续里程碑。当前 Registry 对认证状态只报告 `unknown`，不会把“命令可执行”误报为“已登录”。
