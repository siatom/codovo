---
description: "本地开发：以 dev 模式启动应用（构建 + 运行一条命令搞定）"
allowed-tools: Bash, PowerShell, Read, Grep, Glob, TaskCreate, TaskUpdate, AskUserQuestion
---

**任一步失败就停下来报告原因，不要跳步往下走。** 全程只做启动，不改任何源代码。

开工前先用 TaskCreate 建一条待办：`启动 dev`。进入本节就把它置为 `in_progress`、做完置 `completed`；失败时保持 `in_progress` 并报告，别标记完成。

## 0. 命令环境（先按系统选对再动手）

`pnpm` / `node` 一类的命令在三端的可用 shell 不一样，选错要么直接崩、要么拿不到环境。**每一步开始前先确认当前系统，再用对应环境执行**：

- **Windows**：一律用 **PowerShell 工具**，别用 Bash。Git Bash（MSYS）下 Node 设进程标题会撞 `Assertion failed: process_title, file src\win\util.c`，`pnpm build` 一启动就整个挂掉，根本跑不到真正的构建。
- **macOS**：用 **zsh**——命令包一层 `zsh -lc '<cmd>'`，跟 GUI 进程的 login shell 环境保持一致（Node / pnpm / cargo 常靠 `~/.zprofile` 里的 PATH）。
- **Linux**：用系统**默认 shell**（Bash 工具直接跑即可）。

下文凡是给出 shell 片段的地方，**Windows 看 PowerShell / MSYS 版、macOS / Linux 看 Bash 版**；只给一份的时候默认是 Bash，macOS 上记得包 `zsh -lc`。

## 1. 启动 dev

*（先把「启动 dev」标为 `in_progress`，完成后再标 `completed`。）*

`pnpm tauri dev` 一条命令就把前端 dev server、debug 编译、启动应用全做了——**不要**拆成「先 build 再起 exe」。

### 1a. 启动前清障

`pnpm tauri dev` 的两个最常见失败，都是上一次没退干净留下的，先扫一遍。**只做当前系统那一套**。

#### 1a-1. 5273 端口被占（vite 孤儿进程）

**Windows（Bash 工具）**：
```
netstat -ano | grep ":5273" | grep LISTENING
```
有输出说明被占。用 **PowerShell 工具** `Get-CimInstance Win32_Process` 查那个 PID 的命令行，确认是本项目的 vite/node（命令行含 `D:\CodeProjects\CodeDock`）后再停掉它；父进程链还在就照 `ParentProcessId` 一并停。

**macOS / Linux（Bash 工具）**：
```
lsof -nP -iTCP:5273 -sTCP:LISTEN          # 没装 lsof 就退到：ss -ltnp | grep ':5273'
```
拿到 PID 后用 `ps -p <pid> -o args=` 确认命令行属于本项目（含本仓库路径）再停：
```
kill -TERM <pid>          # 赖着不走再：kill -KILL <pid>
```

**别误杀**：CodeBuddy 自己的 node 进程、别的项目的 vite 都不动。

#### 1a-2. 已有的 dev 版进程（占着 5273 / 9222，还锁着可执行文件，必须先处理）

Windows 上 dev 固定带 CDP（见 1b），所以**上一轮的 dev 必须先退掉再重起**——同 identifier 的 dev 受 `tauri-plugin-single-instance` 约束，旧实例不退，新起的这次不会新开窗口、只会把旧实例唤到前台，CDP 参数根本不生效。**只处理 dev 版**（`target\debug\codedock.exe`），安装版（`AppData\Local\CodeDock\codedock.exe`，macOS 的 `/Applications/CodeDock.app`、Linux 的 `/usr/bin/codedock`）一律别碰。

**Windows（PowerShell 工具）**：按 CommandLine 找 `target\debug\codedock.exe`，分两种：
- **有窗口**（`tasklist /V` 里 Window Title 不是 `N/A`）→ 是用户正在用的 dev 实例。**用 AskUserQuestion 问用户是否关闭它**：
  - 同意 → 按 PID 关掉：`taskkill //F //PID <pid>`（dev 版没有可脚本化的优雅退出，`CloseMainWindow()` 只会把它收进托盘、退不掉）。**只杀 `target\debug` 那个 PID，别用 `//IM codedock.exe`**——那会连安装版一起杀。确认真退了再往下走。
  - 拒绝 → 停下报告，**不启动**。
- **无窗口僵尸**（Window Title `N/A`）→ 没在用，直接停掉它。

**macOS / Linux（Bash 工具）**：
```
pgrep -af 'target/debug/codedock'         # 排除已安装版（路径在 /Applications、/usr/bin）
```
- **macOS**：用 `osascript -e 'tell application "System Events" to count windows of (first process whose unix id is <pid>)'` 数窗口。0 就是残留，直接停；非 0 或**脚本报错（没授权辅助功能）**都按「在用」处理，**用 AskUserQuestion 问用户是否关闭**，同意才停。
- **Linux**：没有统一的、可依赖的窗口检测手段（`xdotool` / `wmctrl` 未必装），**一律按「可能在用」处理**——报告 PID 和命令行后**用 AskUserQuestion 问用户是否关闭**；同意才 `kill -TERM <pid>`。

两项都干净就直接进 1b。

### 1b. 启动

用 Bash 工具的 `nohup ... &`，**不要**用 `run_in_background`（它会被工具回收，留下没有窗口的僵尸进程，还锁着可执行文件让下次编译失败）。日志**重定向到项目外**（写项目内会触发 HMR 重载）。

**用 `scripts/dev-local.sh` 包一层启动**——它把「跑 dev」和「退出后清场」串在同一进程里：用户关掉 dev 窗口、或 CLI 挂掉之后，它会自动收掉还占着 5273 的 vite 孤儿，保证不留占用（端口探测 / 杀进程按系统分支，三端都可用）。

**Windows（Bash 工具）**——固定带 CDP（远程调试端口 9222），方便之后用 `scripts/cdp-check.cjs` 做界面验证：
```
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222" nohup bash scripts/dev-local.sh > "$TEMP/codedock-dev.log" 2>&1 &
```
9222 被别的程序占了就换成别的端口（如 9223），之后调 `cdp-check.cjs` 时带上 `"port":"9223"`。

**macOS（Bash 工具，包 `zsh -lc` 让脚本里的 pnpm 拿到 login PATH）**：
```
nohup zsh -lc 'bash scripts/dev-local.sh' > "${TMPDIR:-/tmp}/codedock-dev.log" 2>&1 &
```

**Linux（Bash 工具）**：
```
nohup bash scripts/dev-local.sh > "${TMPDIR:-/tmp}/codedock-dev.log" 2>&1 &
```

**不要**直接 `nohup pnpm tauri dev ... &`——那样窗口一关就没人收尾，残留的 vite 会让下一次启动失败。

### 1c. 校验；没起来就自动修一次再重试

别等固定时长——每 ~15 秒查一次，最多等 3 分钟。**下列检查都满足**才算起来（Windows 上还多一条 CDP 判据）。

vite 在监听（**Windows**）：
```
netstat -ano | grep ":5273" | grep LISTENING
```
vite 在监听（**macOS / Linux**）：
```
lsof -nP -iTCP:5273 -sTCP:LISTEN          # 没装 lsof 就退到：ss -ltnp | grep ':5273'
```

再用对应工具确认 dev 版进程在跑，**别错认成已安装版**（Windows 的 `AppData\Local\CodeDock\codedock.exe`、macOS 的 `/Applications/CodeDock.app`、Linux 的 `/usr/bin/codedock`）：
- **Windows（PowerShell 工具）**：查 `target\debug\codedock.exe` 进程。
- **macOS / Linux（Bash 工具）**：`pgrep -af 'target/debug/codedock'`。

**Windows 再确认 CDP 真的起来了**（这一条是 Windows 专有的第三个判据）：`netstat -ano | grep ":9222" | grep LISTENING` 有输出才算可用；没监听多半是启动时漏了 1b 的 CDP 参数。

**别读它的退出码**：cargo 报错时应用也可能已经正常起来了，判断起没起来只看上面这些检查。

超过 3 分钟还没起来，就读日志（`Read` 日志文件：Windows `$TEMP/codedock-dev.log`、macOS / Linux `${TMPDIR:-/tmp}/codedock-dev.log`）定位，按下表修完**重试一次**——只重试一次，还失败就停下报告，别无限循环：

| 日志症状 | 原因 | 处理 |
|---|---|---|
| `Port 5273 is already in use` | vite 孤儿占了端口 | 按 1a-1 停掉占用进程，重跑 1b |
| `os error 5` / `拒绝访问`（Windows）、`Text file busy` / `ETXTBSY`（macOS / Linux） | 残留的 dev 进程锁着可执行文件 | 按 1a-2 处理（有窗口 / 可能在用的先问用户是否关闭）再重跑 |
| `error: could not compile`、tsc / 类型报错 | 代码问题 | **不要改代码**，直接停下贴原始错误 |

修复只允许动**进程和端口**，**不改任何源代码**。

- 起来之后这条命令**常驻**：vite dev server 一直跑（前端 HMR），改 `src-tauri/*.rs` 会自动重编重启。别等它退出。
- 报告进程 PID 和平台分支。**不要**自动关掉它，交给用户。

另外两条已知坑：

- **CDP 调试端口只在 Windows 可用**：Windows 上 dev 已经固定带 `--remote-debugging-port=9222`（见 1b），`scripts/cdp-check.cjs` 直接连即可（用法见 `.codebuddy/skills/cdp-verify/`）。macOS 是 WKWebView、Linux 是 WebKitGTK，都没有这套 CDP 端口，该脚本在两端跑不通，改界面要么换回 Windows 验证，要么用各平台自带的开发者工具。**安装版和 dev 天然并存、互不影响**：两者 identifier 不同（`com.codedock` vs `com.codedock.dev`），WebView2 的 user data folder 各归各，9222 只属于 dev 那组——所以**安装版开着照样能连 CDP，别去 taskkill 它、也别叫用户关**。
- 本项目常是「用 CodeDock 开发 CodeDock」：dev 模式下改工作区内任意文件都会触发 HMR 重载（终端重置、编辑器清空），要在这上面开发就先换个工作区。
