# AGENTS.md

CodeDock 仓库协作约定。项目功能与运行方式见 [README.md](./README.md)。技术栈：Rust、Tauri 2、React、TypeScript、Tailwind、Monaco、xterm.js。

## 常用命令

```bash
pnpm tauri dev
pnpm build
cd src-tauri && cargo test --lib
cd src-tauri && cargo clippy
```

前端改动至少运行 `pnpm build`。界面行为改动可按 `.codebuddy/skills/cdp-verify/` 使用 `scripts/cdp-check.cjs` 验证。

## 开发约定

- 先读相关实现再修改；只做请求范围内的改动，不顺手重命名、重排或清理代码。
- 考虑 Windows、macOS、Linux 差异。注释用中文，说明原因或容易误解之处。
- 使用项目现有的语义颜色、组件导出、Context 和图标约定；新增颜色时同步维护 `styles.css` 的主题变量。
- 设置项需同步类型/默认值、设置表单和消费方。Tauri 命令需在 Rust 定义、`lib.rs` 注册，并由前端 `lib/*.ts` 封装；组件不直接 `invoke`。
- 版本号以 `package.json` 为准，只用 `pnpm version patch|minor|major` 修改。未获明确授权，不推送、不建 PR、不推分支。

## 关键实现决定

- 多工作区状态按 root 隔离；切换时保留会话与界面状态。
- 所有文件访问必须校验工作区边界；凭据存系统凭据库。
- 修改前阅读相关代码和注释，遵循现有行为与安全约束。
## 发布

发版时使用 `pnpm version patch|minor|major`。推送 tag 需要用户明确授权。

