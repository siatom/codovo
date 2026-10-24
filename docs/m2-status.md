# M2 任务管理与工作区状态

M2 在 M1 控制面 SQLite 上增加任务领域与工作区证据链。实现集中在 `src-tauri/src/task_plane.rs`，前端封装在 `src/lib/task-plane.ts`，设置页提供最小 Goal/Task 看板入口。

## 任务映射

| 任务 | 实现与验收 |
| --- | --- |
| CODO-201 | Goal、Milestone、Task 表；版本号乐观锁；任务状态转换白名单，非法转换返回 `invalid_transition` |
| CODO-202 | Proposal 表；pending/approved/rejected/merged 决策；版本号与 pending 条件保证审批幂等 |
| CODO-203 | 父子任务环检测；依赖边插入前遍历 DAG，拒绝自环和可达环 |
| CODO-204 | Task Run `attempt_no`、Session/Profile/Worktree 关联、running/finished 状态与失败重试记录 |
| CODO-205 | Tauri CRUD/列表命令和设置页 Goal/Task 基础创建、刷新与状态展示 |
| CODO-206 | Project/Repository 模型；仓库路径 canonicalize 并用 `git rev-parse` 校验有效性 |
| CODO-207 | Worktree lease 表与 acquire/release/list 命令；只允许已登记 Git worktree，重复租约拒绝 |
| CODO-208 | Run 保存 baseline/final SHA、dirty 标记、changed paths |
| CODO-209 | Run 启动/结束命令连接既有 Profile、Session、Worktree 字段；Adapter 执行仍由 M1 Runtime 承担 |
| CODO-210 | 独立 Verification 表；Agent 声明、自动检查和人工验收通过 `source` 区分 |
| CODO-211/212 | `proposal_from_session` 将原生 Session 转为待审批 Proposal；设置页提供 Task→Run→验收的基础导航，不把普通对话直接登记为 Task |
| CODO-213 | 前端构建与领域静态测试已覆盖；Rust 集成测试受本机 `aws-lc-sys` MSVC 阻断，见验证记录 |

## 数据表

新增 `goals`、`milestones`、`tasks`、`task_dependencies`、`proposals`、`task_runs`、`projects`、`repositories`、`worktree_leases`、`run_verifications`。表由幂等 `CREATE TABLE IF NOT EXISTS` 初始化，并使用外键、唯一约束和索引保护引用关系。

## 验证

- `pnpm.cmd build`：通过，TypeScript 与 Vite 构建成功。
- `rustfmt --edition 2021 --check`：新增 Rust 模块通过。
- `git diff --check`：通过。
- `cargo test --lib`：通过；共享目标目录复用依赖后，379 个 Rust 单测全部通过。

## 安全边界

Worktree 租约不会删除目录；已有 Git worktree 的创建/移除仍走现有 `git.rs` 的安全命令。Run 完成不会自动宣称 Task 已验收，必须另有 Verification 记录。
