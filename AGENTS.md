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
- 左栏不再有单独的「对话历史」模块：历史挂在每个工作区行下，悬停行首的箭头展开，把该工作区各根下各家 AI CLI 的会话按最后活动时间合并成一条列表（`WorkspaceHistory.tsx` + `lib/cli-sessions.ts` 的 `listWorkspaceHistory`），每条显示标题、CLI、时间；点一条先切到那个工作区再新开终端标签跑 resume；悬停一条可改名（只存本地覆盖表 `codovo.cliSessionTitles`，不写回 CLI 自己的会话记录，清空即恢复原名）。记录直接读各家 CLI 写在磁盘上的文件，所以没在设置里配过的 CLI 也看得见历史，resume 用设置里的命令、没配过就退回 `CliProvider.bin`。单个 CLI 读失败只当它没有记录，不打断整块列表。
- 所有文件访问必须校验工作区边界；凭据存系统凭据库。
- 启动终端里的 AI CLI 时，把工作区中除活动根以外的目录按各家 CLI 支持的参数注入（`src/lib/cli-launch.ts`，Claude Code / CodeBuddy / Codex / Antigravity / Copilot 用 `--add-dir`，Gemini / Qwen / iFlow 用 `--include-directories`），保证 CLI 的权限范围与工作区一致。用户自己已在命令里写了同名参数时不重复注入。opencode（v2）通过 `OPENCODE_CONFIG_CONTENT` 注入 `permissions` 并加 `--standalone` 起私有服务，显式 `--server` 时不注入；V2 的 `external_directory` 默认全量 allow，所以必须写 `*` 的 ask 兜底 + 工作区目录的 allow 例外，只写 allow 等于没写；单根工作区只有 ask 兜底，也照样注入；PTY 的环境变量由 `pty_spawn` 的 `env` 参数传入。
- 内置 AI 生成能力（翻译、提交方案、解读改动/文件、反馈正文、CICD 配置建议与诊断、预览诊断）统一走 `llm::complete`：单轮、无工具、不落会话，提示词由 `ai.rs` 自己拼。运行时是 Rust 侧的 Rig（`rig-core` + `rig-agent` + `rig-memory`，不引 `rig` 元 crate——它默认特性会拉 lancedb / fastembed 一整串）。`ai.rs` 的直连 HTTP 只保留 `ai_test_provider` / `ai_list_provider_models` 两个连通性探针（它们测的就是用户填的接口本身）。
- 修改前阅读相关代码和注释，遵循现有行为与安全约束。
- 中间区只跑真正的 AI CLI（顶栏切换、已有标签则切过去、没有则新开），不再有 TUI / GUI 双入口。应用助手是右栏抽屉，由进程内的 Rig 运行时驱动（`src-tauri/src/agent/`）；项目级规则 / 记忆 / 技能 / agent 只读 `<root>/.codovo/` 下的文件（`rules.md` / `memory.md` / `skills.json` / `agents.json`），设置面板不再提供可视化编辑。旧的 `settings.agentWorkspaces` 只用于一次性迁移。
- 预览（`preview.rs`）的进程池与助手槽位（`agent/`）都按工作区 root 分片：预览是独立子进程，助手是进程内运行时（一个 root 一个 `Slot`，各自一份会话目录）。切走工作区都不杀，退出应用统一清理；Tauri 预览在 Windows 上带 CDP 调试端口。
- 「操作对象在前端」的助手工具（应用助手）走 **Tauri 事件桥**：后端 `emit("app-agent-request")` 后用 `oneshot` 等回执，前端执行完调 `app_agent_respond` 写回（见 `agent/tools/app.rs` 与 `lib/app-agent.ts`）。预览 / 数据库助手的目标都在后端进程内，工具直接调用，不用过桥。
- 右栏「变更」只有**工作树状态雷达**一个主视图（`ChangesRadarPane.tsx`）：顶部在「工作树 / 分支」两个列表间切换，默认工作树（含主检出），按「要不要我管」排序，行内不常驻写操作按钮；点一行直接进那棵树（分支则是检出它的那棵树）的完整 Git 面板；未检出的分支没有目录，行不可点。面板内不再有只读详情，也没有全宽审阅工作台。工作树列表回答「有哪些检出、谁在跑」，分支列表回答「有哪些本地分支、被谁检出、还差多少」——分支与工作树的对应关系由工作树一侧的 branch + path 给出，后端只补合并状态与改动规模（`workstream_list`，最多取最近 40 条分支）。暂存 / 提交 / 时间线 / 储藏收进标题栏图标打开的完整 Git 面板（`GitChangesPane.tsx`）。状态判据全应用只有一份（`lib/workstream-state.ts`），雷达之外的信息（终端数、是否在等用户）由 `TerminalPane` 上报会话归属后按 cwd 归到具体工作树。面板仍不做分支检出，保持不抢终端上下文。
## 发布

发版时使用 `pnpm version patch|minor|major`。推送 tag 需要用户明确授权。

