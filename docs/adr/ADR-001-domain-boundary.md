# ADR-001：在现有 Tauri crate 内增量建立 Control Plane

- 状态：accepted for M1
- 日期：2026-10-24
- 相关任务：CODO-003

## 背景

现有仓库是单个 Tauri Rust crate 加 React 前端，已经有稳定的 PTY、文件沙箱、Git 和 Agent command。参考架构建议拆成 `core-domain`、`application`、`ports` 等 workspace，但直接移动现有模块会放大兼容风险。

## 选项

1. 新建 Rust workspace 并迁移现有模块。
2. 继续把 Task 逻辑全部写在 React state/localStorage。
3. 在现有 `src-tauri/src` 内新增领域/应用/基础设施子模块，先以 Tauri command 暴露薄 API。

## 决定

选 3。先在现有 crate 中形成清晰的 `control_plane`、`runtime`、`storage` 边界；只有领域接口稳定且有真实复用需求时再拆 crate。

## 后果

保留当前构建和 Tauri 状态注册，减少迁移风险；需要通过模块可见性和纯类型测试防止新代码直接依赖具体 CLI。前端继续只调用 `src/lib/*.ts` 封装，不直接调用新增 Rust command 以外的存储。
