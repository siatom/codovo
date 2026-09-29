---
description: "本地开发：以 dev 模式启动应用（构建 + 运行一条命令搞定）"
allowed-tools: Bash, PowerShell, Read, Grep, Glob, TaskCreate, TaskUpdate
---

**任一步失败就停下来报告原因，不要跳步往下走。** 全程只做启动，不改任何源代码。

开工前先用 TaskCreate 建一条待办：`启动 dev`。进入本节就把它置为 `in_progress`、做完置 `completed`；失败时保持 `in_progress` 并报告，别标记完成。

## 1. 启动 dev

*（先把「启动 dev」标为 `in_progress`，完成后再标 `completed`。）*

`pnpm tauri dev` 一条命令就把前端 dev server、debug 编译、启动应用全做了——**不要**拆成「先 build 再起 exe」。

### 1a. 启动前清障

`pnpm tauri dev` 的两个最常见失败，都是上一次没退干净留下的，先扫一遍：

1. **5273 端口被占**（vite 孤儿进程）：

```
netstat -ano | grep ":5273" | grep LISTENING
```

有输出说明被占。用 PowerShell 工具 `Get-CimInstance Win32_Process` 查那个 PID 的命令行，确认是本项目的 vite/node（命令行含 `D:\CodeProjects\CodeDock`）后再停掉它；父进程链还在就照 `ParentProcessId` 一并停。
**别误杀**：CodeBuddy 自己的 node 进程、别的项目的 vite 都不动。

2. **无窗口的 dev 版僵尸**（锁着 `target\debug\codedock.exe`，会让 cargo 报 `os error 5`）：

用 PowerShell 工具按 CommandLine 找 `target\debug\codedock.exe`：
- 窗口还活着（`tasklist /V` 里 Window Title 不是 `N/A`）→ 是用户正在用的 dev 实例，**别动**，报告并停下。
- Window Title 是 `N/A`（无窗口僵尸）→ 停掉它。

两项都干净就直接进 1b。

### 1b. 启动

用 Bash 工具的 `nohup ... &`，**不要**用 `run_in_background`（它会被工具回收，留下没有窗口的僵尸 `codedock.exe`，还锁着 exe 让下次编译报 `os error 5`）。日志**重定向到项目外**（写项目内会触发 HMR 重载）。

**用 `scripts/dev-local.sh` 包一层启动**——它把「跑 dev」和「退出后清场」串在同一进程里：用户关掉 dev 窗口、或 CLI 挂掉之后，它会自动收掉还占着 5273 的 vite 孤儿，保证不留占用：

```
nohup bash scripts/dev-local.sh > "$TEMP/codedock-dev.log" 2>&1 &
```

**不要**直接 `nohup pnpm tauri dev ... &`——那样窗口一关就没人收尾，残留的 vite 会让下一次启动失败。

### 1c. 校验；没起来就自动修一次再重试

别等固定时长——每 ~15 秒查一次，最多等 3 分钟。**下面两条都满足**才算起来：

```
netstat -ano | grep ":5273" | grep LISTENING     # vite 在监听
```

再用 PowerShell 工具确认存在 `target\debug\codedock.exe` 进程（别错认成发布版 `AppData\Local\CodeDock\codedock.exe`）。

**别读它的退出码**：cargo 报错时应用也可能已经正常起来了，判断起没起来只看上面两条。

超过 3 分钟还没起来，就读日志（`Read` `$TEMP/codedock-dev.log`）定位，按下表修完**重试一次**——只重试一次，还失败就停下报告，别无限循环：

| 日志症状 | 原因 | 处理 |
|---|---|---|
| `Port 5273 is already in use` | vite 孤儿占了端口 | 按 1a-1 停掉占用进程，重跑 1b |
| `failed to remove file ... os error 5`、`拒绝访问` | 无窗口的 codedock.exe 锁着 exe | 按 1a-2 停掉僵尸再重跑；有窗口的在跑就别动，改为报告用户 |
| `error: could not compile`、tsc / 类型报错 | 代码问题 | **不要改代码**，直接停下贴原始错误 |

修复只允许动**进程和端口**，**不改任何源代码**。

- 起来之后这条命令**常驻**：vite dev server 一直跑（前端 HMR），改 `src-tauri/*.rs` 会自动重编重启。别等它退出。
- 报告进程 PID。**不要**自动关掉它，交给用户。

另外两条已知坑：

- 要挂 CDP 调试端口就用 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222" nohup pnpm tauri dev > "$TEMP/codedock-dev.log" 2>&1 &`。发布版开着时它和 dev 版共用同一个 WebView2 浏览器进程，9222 不会监听——得先请用户关掉发布版（**别**自己 taskkill）。
- 本项目常是「用 CodeDock 开发 CodeDock」：dev 模式下改工作区内任意文件都会触发 HMR 重载（终端重置、编辑器清空），要在这上面开发就先换个工作区。
