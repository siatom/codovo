# AGENTS.md

给在这个仓库里写代码的 AI 助手。功能与架构见 [README.md](./README.md)，
**动手前先扫一遍它的「几个关键实现决定」**——那里的做法都是踩过坑才定下来的。

Rust + Tauri 2 外壳，React 19 + TS + Tailwind 4 前端，Monaco 编辑器，xterm.js 终端。

## 命令

```bash
pnpm tauri dev                    # 开发
pnpm build                        # 前端类型检查 + 构建
cd src-tauri && cargo test --lib  # 后端单测
cd src-tauri && cargo clippy
```

## 约定

- 这是一个跨平台应用，代码要兼容 Windows、macOS 和 Linux；涉及系统 API、路径、进程、快捷键或界面行为时，先考虑三端差异。
- 注释一律中文，写「为什么」。反直觉的写法、绕开的坑、外部库的怪癖都留一句。
- 颜色只用语义类（`bg-surface` / `text-fg-dim`…），不写十六进制。新增颜色要同时改
  `styles.css` 的 `:root`、`:root[data-theme="light"]` 和 `@theme` 三处。
- 组件具名导出（`export function Xxx`），不用 default（`App.tsx` 例外）。
- 状态用 Context（`theme.tsx` / `settings.tsx`），不引状态库。
- 图标走 `icons.tsx` 的 `icon()` 工厂，不内联新 SVG、不用 emoji。
- 只改被要求改的地方：不重排 import、不改命名、不清理"看起来没用"的代码。
  宁可重复三行，也不为一次调用抽函数。
- **没有用户明确允许，不要 `git push`**（也不要顺手开 PR / 推分支到远程）。提交留在本地等确认。

## 加东西时改哪里

- **设置项要动五处**：`settings.tsx`（字段 + `DEFAULTS` + `readSaved` 校验）→
  `SettingsDialog.tsx` 对应 tab → 消费方（`TerminalSession.tsx` / `EditorPane.tsx`）。
  要「立刻生效」就在消费方加依赖该字段的 `useEffect`；注意**建实例的 effect 只认挂载那一刻的值**，
  得另用 ref 兜住。
- **后端命令**：`src-tauri/src/*.rs` 写 `#[tauri::command]` → `lib.rs` 注册 →
  前端在 `lib/fs.ts` / `pty.ts` / `git.ts` 包一层，组件不直接 invoke。
- **编辑器标签类型**：`lib/tabs.ts`（`tabKey` / `sameTab`）+ `EditorPane.tsx`。
- **git 写操作先确认**：README 的「git 不做的事」是明确排除的范围，用户没点名别扩。
- 产品方向是先补齐骨架硬伤、再考虑新能力，AI 面板 / LSP 这类大块别塞进小改动顺手做掉。

## 验证

前端改完至少跑 `pnpm build`（Vite dev 不做类型检查，靠 `tsc` 拦语法和类型错）。
界面改动按 README 的「验证界面（无头）」走 `scripts/cdp-check.cjs`，注意三点：

- `localStorage` 里是用户的真实状态（`codedock.settings` / `workspace(s)` / `theme`），
  为验证改过的值收尾要还原。
- 点按钮用 `element.click()` 就够（React 事件委托挂在 root 上）。
- 应用起没起来看 9222 端口，别看 `pnpm tauri dev` 的退出码——它常报 `exit code: 1` 而应用是好的。
