---
description: "本地开发：提交改动 → 以 dev 模式启动应用（构建 + 运行一条命令搞定）"
allowed-tools: Bash, PowerShell, Read, Grep, Glob, TaskCreate, TaskUpdate
---

按顺序执行下面两步。**任一步失败就停下来报告原因，不要跳步往下走。** 全程只做提交 / 启动，不改任何源代码。

开工前先用 TaskCreate 建两条待办：`提交改动` / `启动 dev`。每进入一步就把它置为 `in_progress`、做完置 `completed`；失败时保持 `in_progress` 并报告，别标记完成。

## 1. 提交改动（规则同 /commit）

*（进入本节先把「提交改动」标为 `in_progress`，完成后再标 `completed`。）*

先 `git status --short` 并通读完整 diff，然后**按主题拆成多个 commit**，不要 `git add -A` 合成一条：

- 按功能切主题（后端命令 / 前端接线 / 文档各自成题），不按文件、不按时间切。
- 同一文件里不同主题的 hunk 用 `git apply --cached` 手工切；同一 hunk 内两个主题交错的可以并成一条，并在提交信息里说明。
- 纯文档更新单独一条 `docs:` 提交。
- 提交信息用 Conventional Commits（`feat` / `fix` / `chore` / `docs` …）。
- **只提交，不 push**——push 要用户明确同意。
- 工作区本来就干净时跳过本节。

## 2. 启动 dev

*（进入本节先把「启动 dev」标为 `in_progress`，完成后再标 `completed`。）*

`pnpm tauri dev` 一条命令就把前端 dev server、debug 编译、启动应用全做了——**不要**拆成「先 build 再起 exe」。用 Bash 工具的 `nohup ... &` 起，**不要**用 `run_in_background`（它会被工具回收，留下没有窗口的僵尸 `codedock.exe`，还锁着 exe 让下次编译报 `os error 5`）：

```
nohup pnpm tauri dev >/dev/null 2>&1 &
```

- 这条命令**常驻**：vite dev server 一直跑（前端 HMR），改 `src-tauri/*.rs` 会自动重编重启。别等它退出。
- **别读它的退出码**：cargo 报错时应用也可能已经正常起来了（退出码不可信）。判断起没起来看进程。
- 用 PowerShell 工具按 CommandLine 认 `target\debug\codedock.exe` 那个（别错认成发布版 `AppData\Local\CodeDock\codedock.exe`）。
- 报告进程 PID。**不要**自动关掉它，交给用户。

撞上这些坑时按这里处理：

- 要挂 CDP 调试端口就用 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222" nohup pnpm tauri dev >/dev/null 2>&1 &`。发布版开着时它和 dev 版共用同一个 WebView2 浏览器进程，9222 不会监听——得先请用户关掉发布版（**别**自己 taskkill），或者干脆不用 9222。
- 上一次 dev CLI 挂掉后 vite 可能变成孤儿进程占着 5273，再起会因端口被占失败：先 `netstat -ano | grep :5273` 找到 PID，连父进程链一起 kill。
- 本项目常是「用 CodeDock 开发 CodeDock」：dev 模式下改工作区内任意文件都会触发 HMR 重载（终端重置、编辑器清空），要在这上面开发就先换个工作区。
