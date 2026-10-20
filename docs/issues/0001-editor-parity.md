# 0001 编辑器功能对齐 CodeLite（P0–P2 完整落地）

- 状态：执行中
- 来源：对照 `D:\CodeProjects\code-lite` 的编辑器实现与 git 提交历史
- 目标仓库：`code-dock`（CodeDock）
- 基线：本地 `main`（领先 `origin/main` 2 个提交，工作区干净）
- 执行分支：`wt/editor-parity`，worktree：`.worktrees/editor-parity`
- 合并方式：所有工作包在同一 worktree 内按顺序提交，最终由主 agent 合并回本地 `main`；默认不 push

## 1. 背景

CodeDock 的 Monaco 编辑内核、Markdown 三态预览、Mermaid / KaTeX / HTML / 相对图片、自动保存、标签拖拽、外部文件重读等已与 CodeLite 基本对齐。仍缺少以下能力：

- 文件生命周期与数据安全：外部修改冲突、大文件降级、放弃变更、另存为、未命名缓冲区、关闭时保存。
- 编辑效率：格式化、保存前语法校验、每标签滚动/选区、查找入口、快捷键、状态栏信息、设置项。
- 边界能力：更多编码、CR 换行、只读文件、标签交互、会话恢复、最近文件、单文件打开与系统拖放。
- Markdown 深度：链接/锚点、围栏代码高亮、大文件预览降级。
- 文档翻译。

本 issue 把上述缺项拆成 6 个实现工作包 + 1 个集成验证工作包。工作包共享 `EditorPane.tsx` 等核心文件，因此**不并行**，在同一个 worktree 内按 WP1 → WP6 顺序由不同 subagent 实现，避免同一文件反复冲突。

## 2. 目标与非目标

### 目标

1. 让 CodeDock 编辑器在文件安全、日常编辑、Markdown、翻译等维度达到 CodeLite 的可用性。
2. 所有新增行为有明确边界，不破坏现有工作区隔离、文件沙箱、凭据不进 WebView 等约束。
3. 每完成一个工作包都能通过构建与后端单测；最终在主工作区完成集成验证。

### 非目标

- 不引入插件系统。
- 不改变工作区中心的产品模型；单文件打开通过临时工作区/文件所在目录工作区实现。
- 不推送远程、不创建 PR、不修改版本号。
- 不顺手重排或重构无关代码。

## 3. 工作包

### WP1 文件系统与编码底座

**负责文件**

- `src-tauri/src/fs_api.rs`
- `src-tauri/src/encoding.rs`
- `src-tauri/src/fs_ops.rs`（如存在）
- `src/lib/fs.ts`
- `src/lib/types.ts`
- 相关 Rust 单测

**任务**

1. 大文件策略对齐 CodeLite：
   - 超过 8MB 标记 `isLarge`，前端关闭语法解析/Markdown 预览等高成本能力。
   - 超过 64MB 只读取前 8MB，标记 `truncated`，强制只读，禁止保存。
   - `FileContent` 增加 `size`、`readOnly`、`truncated`、`isLarge`、`eol`、`hasBom` 等前端需要的字段。
2. 编码扩展：
   - 在现有 UTF-8 / UTF-8 BOM / UTF-16LE / UTF-16BE / GBK / Big5 基础上增加 GB18030、Shift_JIS、EUC-KR、windows-1252、ISO-8859-1。
   - 读取时严格解码，保存时按同一编码回写；编码标签前后端保持一致。
   - 前端编码下拉同步扩展。
3. 换行：
   - 读取时探测 LF / CRLF / CR，正文统一为 LF 交给编辑器。
   - 写回时按原 EOL 还原；前端状态栏可切换 LF / CRLF / CR。
4. 只读：
   - 读取文件权限并返回 `readOnly`；只读文件禁止保存。
5. 补充单元测试：截断读取、只读标记、CR EOL 往返、新编码往返、BOM 保留。

**验收**

- `cargo test --lib` 通过，新增测试覆盖上述行为。
- `cargo clippy` 无新增 warning。
- 3MB 文件可打开并编辑；70MB 文件打开后为前 8MB 且只读、不可保存。
- GB18030 / Shift_JIS / EUC-KR / windows-1252 文件可读，保存后编码不被破坏。
- CR 换行文件打开、保存后仍是 CR。

### WP2 编辑器生命周期

**负责文件**

- `src/components/EditorPane.tsx`
- `src/components/WorkspacePane.tsx`
- `src/components/ConfirmDialog.tsx`（仅扩展多按钮）
- `src/App.tsx`
- `src/lib/tabs.ts`
- `src/lib/fs.ts`（按需）
- `src/lib/window.ts`（仅关闭流程）

**任务**

1. 外部修改冲突：
   - 标签增加 `externalState`：`none | updated | conflict | deleted`。
   - 后端 `fs-file-changed` 到达时：
     - 文件已删除 → `deleted`。
     - 标签有未保存修改 → `conflict`，绝不覆盖编辑内容。
     - 标签干净 → 重读并同步；非前台标签标记 `updated`。
     - 自己的保存回声用 mtime 忽略。
   - 标签上显示冲突/已删除/已更新标记；标签右键提供「重新加载（放弃我的修改）」「保留我的修改」。
   - 切到标签时清除 `updated` 提醒，`conflict` / `deleted` 保留到用户处理。
2. 放弃变更：
   - 工具栏与标签菜单提供「放弃变更」；已落盘文件从磁盘重读，未命名缓冲区回到最近保存快照。
3. 另存为与未命名缓冲区：
   - `Tab` 支持 `path: string | null`；`Ctrl+N` 新建未命名缓冲区。
   - `Ctrl+Shift+S` 另存为，保存成功后更新路径、标题、最近文件。
   - 未命名缓冲区保存时自动走另存为。
4. 关闭流程：
   - 有未保存修改时提供「保存 / 不保存 / 取消」三选一；保存失败或另存为取消时中止关闭。
   - 批量关闭逐个处理脏标签。
5. 大文件 / 只读 / 截断 UI：
   - `isLarge`：禁用 Markdown 预览与高语义功能，状态栏标记「大文件」。
   - `truncated`：显示「已截断，只读」，禁止保存与另存为。
   - `readOnly`：编辑器只读，保存按钮禁用，状态栏标记「只读」。
6. EOL / BOM：
   - 打开时使用后端返回的 `eol`；保存时按当前 `eol` + `hasBom` 写回。
   - 状态栏 EOL 菜单支持 LF / CRLF / CR。

**验收**

- 外部修改干净文件自动同步；脏文件出现冲突标记且内容不被覆盖；「重新加载」「保留我的修改」均生效。
- 外部删除文件后标签标记「已删除」，用户可选择保留内容或关闭。
- 放弃变更后内容回到磁盘版本/保存快照。
- 未命名缓冲区可编辑、另存为、关闭时保存。
- 关闭脏标签时可选保存、不保存、取消。
- 大文件、截断、只读状态可见且保存行为正确。
- CR 文件保存后仍是 CR。

### WP3 编辑效率与标签交互

**负责文件**

- `src/components/EditorPane.tsx`
- `src/components/SettingsDialog.tsx`
- `src/lib/settings.tsx`
- `src/lib/shortcuts.ts`
- `src/lib/tabs.ts`
- `package.json` / `pnpm-lock.yaml`
- 新增 `src/lib/formatter.ts`、`src/lib/validate.ts`（名称可调整）
- `src/components/ExplorerPane.tsx`（仅格式化右键项）

**任务**

1. 格式化：
   - 引入 Prettier（浏览器版，按语言插件动态 import）。
   - 覆盖 JS/JSX/TS/TSX/JSON(C/5)/CSS/SCSS/Less/HTML/Vue/Markdown/MDX/YAML/GraphQL；其他语言退回 Monaco 缩进重排。
   - 触发器：工具栏按钮、`Shift+Alt+F`、文件树右键、保存时格式化设置。
   - 格式化保留光标位置，可撤销；失败不阻断保存。
2. 保存前语法校验：
   - 复用 Prettier 解析器；JSON/JSONC/YAML/JS/TS/CSS/HTML/Markdown/GraphQL。
   - 交互式保存弹「仍然保存 / 取消」；自动保存只提示不打断，并按问题签名去重。
   - 增加 `formatOnSave`、`checkSyntaxOnSave` 设置项。
3. 每标签视图状态：
   - 用 `editor.saveViewState()` / `restoreViewState()` 保存滚动位置、光标、选区。
   - 关闭标签时清理状态。
4. 查找入口：
   - 工具栏提供查找按钮，切换 Monaco find widget；`Ctrl+F` / `Ctrl+H` 保持可用。
5. 标签交互：
   - 中键关闭；标签栏空白双击新建文件；脏标签圆点点击保存。
   - 标签右键增加「打开所在目录」「在文件管理器中显示」「放弃变更」。
   - `Ctrl+Tab` / `Ctrl+PageUp/PageDown` 切换标签。
6. 快捷键扩展：
   - 新增可配置命令：保存、另存为、新建文件、打开文件、查找、格式化、切换 Markdown 预览、下一个/上一个标签、放大/缩小/重置字号、设置、侧栏开关。
   - 保留终端 `Ctrl+C/V` 与 Esc 的内置语义。
7. 状态栏：
   - 增加文件大小、选区长度、只读/大文件/截断标记、点击路径复制。
   - 保留光标位置、语言、缩进、EOL、编码。
8. 编辑器设置：
   - 行号开关、当前行高亮、行高、格式化/校验开关。
   - 字号快捷键与设置双向同步。
9. 验收：
   - `pnpm build` 通过。
   - 格式化、保存前校验、每标签滚动/选区、标签交互、快捷键、状态栏、设置项均可用。
   - 不破坏 Monaco 自带的 Ctrl+F/H、撤销、多光标。

### WP4 Markdown 预览

**负责文件**

- `src/components/MarkdownPreview.tsx`
- `src/lib/markdown.ts`
- `src/lib/highlight.ts`
- `src/components/EditorPane.tsx`（仅预览接线）

**任务**

1. 链接：
   - 外链用 `@tauri-apps/plugin-opener` 的 `openUrl` 打开系统浏览器。
   - `#anchor` 页内跳转；为标题生成稳定 id（支持中文）。
2. 围栏代码高亮：
   - 复用现有 `highlightCodeFences`（Monaco colorize），整屏预览与对照预览都生效。
   - 高亮失败时回退纯文本，不阻断渲染。
3. 大文件：
   - `isLarge` 时跳过 Markdown 预览，显示「大文件已关闭预览」提示。
4. 其他：
   - 保持现有 Mermaid、KaTeX、HTML、相对图片、frontmatter 行为。
   - 相对图片/视频/音频继续走沙箱 asset URL。
5. 验收：
   - 外链不再被吞掉；页内锚点可跳转；标题 id 稳定。
   - 围栏代码有语法高亮，明暗主题切换后颜色正确。
   - 8MB 以上 Markdown 不渲染预览。

### WP5 文档翻译

**负责文件**

- 新增 `src/lib/translate.ts`
- 新增 `src/components/TranslationView.tsx`
- `src/components/EditorPane.tsx`（工具栏与视图模式）
- `src/lib/settings.tsx`
- `src/components/SettingsDialog.tsx`
- `src/lib/ai.ts`
- `src-tauri/src/ai.rs`（新增翻译命令）
- `src-tauri/src/lib.rs`（命令注册）

**任务**

1. 入口：
   - 仅 Markdown / 纯文本等文档类型显示翻译按钮；源码、脚本、配置不显示。
   - 视图三态扩展为「编辑 / 预览 / 对照 / 翻译」，翻译为左原文右译文。
2. 目标语言：简体中文 / English，可随时切换并重新翻译。
3. 长文档分段请求，显示进度（已完成段/总段），可停止、重试、复制译文。
4. 内容保护：代码块、行内代码、目录、文件/目录树、链接引用、徽章不翻译；表格正文翻译。
5. 缓存：按源文件内容签名 + 目标语言 + 模型缓存译文，重新打开/重启后复用；手动「重新翻译」忽略缓存。
6. 配置：复用现有 AI provider/model，不新增明文密钥；翻译目标语言持久化。
7. 失败处理：译文部分成功时保留已译内容并显示错误条与重试。
8. 验收：
   - 配置 provider 后可翻译 Markdown/文本；未配置时显示引导。
   - 代码块与目录结构保持原样；表格正文被翻译。
   - 进度、停止、重试、复制、缓存均可用。
   - 翻译不改变原文文件。

### WP6 文件入口、会话与最近文件

**负责文件**

- `src/App.tsx`
- `src/components/WorkspacePane.tsx`
- `src/components/EditorPane.tsx`（按需）
- `src/components/Sidebar.tsx`（按需）
- 新增 `src/lib/session.ts` / `src/lib/recent.ts`
- 新增或扩展 `src/components/WelcomeScreen.tsx`

**任务**

1. 会话恢复：
   - 按工作区持久化打开的标签路径、激活标签、编辑器视图状态。
   - 启动恢复上次工作区时恢复标签；关闭工作区不丢记录。
2. 最近文件：
   - 记录最近打开文件（路径、时间），上限 50。
   - 编辑器空态/欢迎页展示最近文件，点击直接打开。
3. 单文件打开：
   - `Ctrl+O` 弹出文件选择框。
   - 文件在当前工作区内 → 直接打开；不在任何工作区 → 以文件所在目录创建/复用临时工作区后打开。
4. 系统拖放：
   - 监听 Tauri `onDragDropEvent`：文件夹 → 打开工作区；文件 → 按单文件规则打开。
5. 关闭工作区时清理该工作区的会话记录与视图状态。
6. 验收：
   - 重启后恢复上次工作区与标签。
   - 最近文件可点击打开。
   - `Ctrl+O` 可打开工作区外文件。
   - 把文件/文件夹拖进窗口能打开。

### WP7 集成验证（由 tester 执行）

1. `pnpm build`
2. `cd src-tauri && cargo test --lib`
3. `cd src-tauri && cargo clippy`
4. `git diff --check`
5. 手工冒烟：
   - 普通文件编辑/保存/撤销/查找替换/格式化。
   - 大文件、只读、截断、CR/CRLF、GBK/GB18030/Shift_JIS。
   - 外部修改冲突、删除、放弃变更、另存为、未命名缓冲区、关闭保存。
   - Markdown 三态、同步滚动、Mermaid、KaTeX、代码高亮、外链、锚点。
   - 翻译配置、分段进度、停止/重试/缓存。
   - 标签中键关闭、双击空白新建、快捷键、状态栏。
   - 会话恢复、最近文件、Ctrl+O、系统拖放。

## 4. 风险与边界

- **工作区沙箱**：所有文件读写仍须经过 `root` 校验；单文件打开通过临时工作区实现，不绕过沙箱。
- **大文件性能**：8MB 以上禁用高成本能力；64MB 以上只读截断，不做全文加载。
- **翻译隐私**：只发送正文分段，不发送代码块/目录/链接引用；密钥仍只在系统钥匙串，不进入 WebView。
- **跨平台**：Windows 为主要验证平台；macOS/Linux 的路径、快捷键、拖放行为需在对应平台补验。
- **不 push**：合并到本地 `main` 后由用户决定是否推送。

## 5. 验证命令

```bash
pnpm build
cd src-tauri && cargo test --lib
cd src-tauri && cargo clippy
git diff --check
```

## 6. 进度记录

| 工作包 | 状态 | commit | 备注 |
| --- | --- | --- | --- |
| WP1 文件系统与编码底座 | 已完成 | 69f53e3 | 大文件截断 / 扩展编码 / EOL 与 BOM 元数据；EOL 正文归一化留给 WP2 |
| WP2 编辑器生命周期 | 待开始 | | |
| WP3 编辑效率与标签交互 | 待开始 | | |
| WP4 Markdown 预览 | 待开始 | | |
| WP5 文档翻译 | 待开始 | | |
| WP6 文件入口、会话与最近文件 | 待开始 | | |
| WP7 集成验证 | 待开始 | | |
