# AGENTS.md

Codovo（中文名「码坞」）仓库协作约定。项目功能与运行方式见 [README.md](./README.md)。技术栈：Rust、Tauri 2、React、TypeScript、Tailwind、Monaco、xterm.js。

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
- 文件树 / Git 改动树 / 文件面板的图标来自 `material-icon-theme`（devDependency）：`dev` / `build` / `install` 会先跑 `scripts/gen-file-icons.mjs`，把映射和用得到的 svg 生成到 `public/material-icons/`（不进仓库）。换版本改 devDependency 再跑 `pnpm gen:file-icons`；查表逻辑在 `src/components/fileIcons.tsx`。
- 版本号以 `package.json` 为准，只用 `pnpm version patch|minor|major` 修改。未获明确授权，不推送、不建 PR、不推分支。

## 关键实现决定

- 多工作区状态按 root 隔离；切换时保留会话与界面状态。
- 工作区列表按「最近活动」排序：置顶组固定在前，组内按终端 / 助手最近使用时间倒序（活动按 root 记、存 `codovo.workspaceActivity`，`src/lib/activity.tsx`）。列表不提供拖拽手动排序。
- 所有文件访问必须校验工作区边界；凭据存系统凭据库。
- 启动终端里的 AI CLI 时，把工作区中除活动根以外的目录按各家 CLI 支持的参数注入（`src/lib/cli-launch.ts`，Claude Code / CodeBuddy / Codex / Antigravity / Copilot 用 `--add-dir`，Gemini / Qwen / iFlow 用 `--include-directories`），保证 CLI 的权限范围与工作区一致。用户自己已在命令里写了同名参数时不重复注入。opencode（v2）通过 `OPENCODE_CONFIG_CONTENT` 注入 `permissions` 并加 `--standalone` 起私有服务，显式 `--server` 时不注入；V2 的 `external_directory` 默认全量 allow，所以必须写 `*` 的 ask 兜底 + 工作区目录的 allow 例外，只写 allow 等于没写；单根工作区只有 ask 兜底，也照样注入；PTY 的环境变量由 `pty_spawn` 的 `env` 参数传入。
- 修改前阅读相关代码和注释，遵循现有行为与安全约束。
- 中间区只跑真正的 AI CLI（顶栏切换、已有标签则切过去、没有则新开），不再有 TUI / GUI 双入口。应用助手是右栏抽屉，仍由 opencode 驱动；项目级规则 / 记忆 / 技能 / agent 只读 `<root>/.codovo/` 下的文件（`rules.md` / `memory.md` / `skills.json` / `agents.json`），设置面板不再提供可视化编辑。旧的 `settings.agentWorkspaces` 只用于一次性迁移。
- 预览（`preview.rs`）与助手服务（`agent.rs`）的进程池都按工作区 root 分片、是独立子进程，切走工作区不杀、退出应用统一清理；Tauri 预览在 Windows 上带 CDP 调试端口。
- 「操作对象在前端」的 MCP 工具（应用助手、预览助手）走**文件邮箱桥**：MCP 子进程写请求文件 → 前端轮询执行 → 写回结果（见 `app_agent.rs` / `preview_agent.rs`）。
## 发布

发版时使用 `pnpm version patch|minor|major`。推送 tag 需要用户明确授权。

