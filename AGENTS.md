# AGENTS.md

给在这个仓库里写代码的 AI 助手；功能见 [README.md](./README.md)。栈：Rust + Tauri 2 外壳、
React 19 + TS + Tailwind 4、Monaco 编辑器、xterm.js 终端。**动手前先扫一遍「关键实现决定」。**

## 命令

```bash
pnpm tauri dev                    # 开发
pnpm build                        # 前端类型检查 + 构建
cd src-tauri && cargo test --lib  # 后端单测
cd src-tauri && cargo clippy
```

## 约定

- 跨平台：涉及系统 API / 路径 / 进程 / 快捷键 / 界面行为时，先考虑 Windows、macOS、Linux 差异。
- 注释一律中文、写「为什么」；反直觉的写法、绕开的坑留一句。
- 颜色只用语义类（`bg-surface`…），新增要同时改 `styles.css` 的 `:root` / `:root[data-theme="light"]` /
  `@theme`；组件具名导出（`App.tsx` 例外）、状态用 Context、图标走 `icons.tsx`。
- 只改被要求改的地方：不重排 import、不改命名、不清理"看起来没用"的代码；宁可重复三行。
- 设置项要动五处（`settings.tsx` → `SettingsDialog.tsx` → 消费方）；后端命令 `*.rs` 写
  `#[tauri::command]` → `lib.rs` 注册 → 前端 `lib/*.ts` 包一层，组件不直接 invoke。
- 没有用户明确允许，不要 `git push` / 开 PR / 推分支；提交留在本地等确认。

## 关键实现决定

> 都是踩过坑才定下来的，改之前先弄清为什么。

- 终端输出传**原始字节**、后端不解码（`read()` 会截断多字节 UTF-8）；非当前会话 `display:none` 藏而不卸载
  （卸载会杀 shell）；换工作区靠重开 shell、前后端根目录一起换；容器不设 padding 且 `overflow-clip`。
- 文件路径一律词法归一化 + 前缀校验，已存在的再 `canonicalize` 挡软链接逃逸；文件树改名 / 删除
  要带着编辑器标签一起换或关，改名前先落盘；工作区根禁改禁删。
- 目录监听只推「哪个父目录变了」，编辑器重读另走 `fs-file-changed`；防抖 300ms 并跳过 `SKIP_DIRS`。
- 差异基线照 VS Code（暂存 `HEAD↔index`、未暂存 `index↔工作区`），两侧统一按 LF 比较；差异编辑器
  懒创建、只读、不参与脏标记，三种差异靠 model URI 的 scheme 段区分。
- git 状态走 `status --porcelain=v2 --branch -z`；工作区可能只是仓库子目录，先 `rev-parse --show-prefix`；
  轮询命令带 `--no-optional-locks`（写操作不带）、Windows 上加 `CREATE_NO_WINDOW`；暂存带
  `--literal-pathspecs`、「全部暂存」给 `.`。
- AI / 智能体：HTTP 与 SSE 全走 Rust 代理，前端不直连 opencode；规则 / 记忆 / 技能 / Agents
  存 localStorage、启动时才物化；兼容两代接口、按接口探测（判据是响应里有 `version` 字段）。
- 破坏性确认框自研（WKWebView 不支持 `window.confirm`）；右边栏内容面板 `hidden` 藏着不卸载；
  调试用 AI 参数覆盖只在 debug 构建（`dev.rs`），别用 `dotenvy`（`set_var` 会泄密钥进 PTY）。

## 验证

前端改完至少跑 `pnpm build`（Vite dev 不做类型检查）；界面改动走 `scripts/cdp-check.cjs`（WebView2 的
CDP 端口做截图 / 求值 / 输入）。注意：`localStorage` 是用户真实状态、验证后要还原；拖动必须走 `drag`
而非合成 PointerEvent（应用用 `setPointerCapture`）；应用起没起来看 9222 端口。dev 下改工作区内任意
文件会触发 HMR 重载（终端重置、编辑器清空），是 dev server 产物，用 CodeDock 开发 CodeDock 时换工作区。
