---
description: "本地构建安装：提交改动 → 构建 NSIS 安装包 → 装到本机（不 push）"
allowed-tools: Bash, PowerShell, Read, Grep, Glob, TaskCreate, TaskUpdate, AskUserQuestion
---

按顺序执行下面三步。**任一步失败就停下来报告原因，不要跳步往下走。** 全程只做提交 / 构建 / 安装，不改任何源代码。

开工前先用 TaskCreate 建三条待办：`提交改动` / `构建安装包` / `装到本机`。每进入一步就把它置为 `in_progress`、做完置 `completed`；失败时保持 `in_progress` 并报告，别标记完成。

## 0. 命令环境（先按系统选对再动手）

`pnpm` / `node` 一类的命令在三端的可用 shell 不一样，选错要么直接崩、要么拿不到环境。**每一步开始前先确认当前系统，再用对应环境执行**：

- **Windows**：一律用 **PowerShell 工具**，别用 Bash。Git Bash（MSYS）下 Node 设进程标题会撞 `Assertion failed: process_title, file src\win\util.c`，`pnpm build` 一启动就整个挂掉，根本跑不到真正的构建。
- **macOS**：用 **zsh**——命令包一层 `zsh -lc '<cmd>'`，跟 GUI 进程的 login shell 环境保持一致（Node / pnpm / cargo 常靠 `~/.zprofile` 里的 PATH）。
- **Linux**：用系统**默认 shell**（Bash 工具直接跑即可）。

## 1. 提交改动（规则同 /commit）

*（进入本节先把「提交改动」标为 `in_progress`，完成后再标 `completed`。）*

先 `git status --short` 并通读完整 diff，然后**按主题拆成多个 commit**，不要 `git add -A` 合成一条：

- 按功能切主题（后端命令 / 前端接线 / 文档各自成题），不按文件、不按时间切。
- 同一文件里不同主题的 hunk 用 `git apply --cached` 手工切；同一 hunk 内两个主题交错的可以并成一条，并在提交信息里说明。
- 纯文档更新单独一条 `docs:` 提交。
- 提交信息用 Conventional Commits（`feat` / `fix` / `chore` / `docs` …）。
- **只提交，不 push**——push 要用户明确同意。
- 工作区本来就干净时跳过本节。

## 2. 构建安装包

*（进入本节先把「构建安装包」标为 `in_progress`，完成后再标 `completed`。）*

### 2a. 构建前校验

先确认工作区干净，再记下当前 HEAD：

```
git status --porcelain
git rev-parse --short HEAD
```

`git status --porcelain` **必须一行输出都没有**。有输出说明第 1 步没提交干净——回去补提交，**不要**带着未提交改动构建（否则产物带 `.dirty`、装上去的东西和提交对不上）。

### 2b. 构建

用**第 0 步选定的环境**、**后台**跑（release 编译很慢，不要放前台等）：Windows 走 PowerShell 工具，macOS 包 `zsh -lc`，Linux 走 Bash。

```
pnpm tauri build --bundles nsis
```

- Windows 上**务必用 PowerShell 工具**：换成 Bash 会撞 `process_title` 断言直接崩（见第 0 步）。
- **后台任务要给足超时**：release 编译远超工具默认的 2 分钟，跑后台时显式带上 `timeout`（如 600000ms），否则会在编译中途被掐断、误判成构建失败。
- `tauri.conf.json` 的 `beforeBuildCommand` 已包含 `pnpm build`（tsc + vite），**不要**再单独跑一遍前端构建。
- 这里只出 NSIS 包（msi/WiX 对本机安装没用，跳过省时间）。命令行参数不改仓库配置，正常发版仍是全量。
- 类型错误、rust 编译失败就停下报告，别继续装。

### 2c. 构建后校验

Vite 会把 `<version>+<git 短 hash>[.dirty]` 注入前端产物，核对它和当前 HEAD 是否一致（防止装到用旧 commit 构建的包）：

```
expected="$(node -p "require('./package.json').version")+$(git rev-parse --short HEAD)"
actual="$(grep -ohE '[0-9]+\.[0-9]+\.[0-9]+\+[A-Za-z0-9._-]+' dist/assets/*.js | sort -u)"
echo "expected=$expected"; echo "actual=$actual"
```

- 两者**必须相等**，且 `actual` 只应有一行。不一致就停下报告，**不要**继续安装——说明 dist 是旧的，或构建用的不是当前 commit。
- 出现 `.dirty` 后缀同样算失败。
- 把通过校验的标识记下来，第 3 步报告时用。

## 3. 装到本机

*（进入本节先把「装到本机」标为 `in_progress`，完成后再标 `completed`。）*

产物：`src-tauri/target/release/bundle/nsis/CodeDock_<version>_x64-setup.exe`，`<version>` 取 `package.json` 的 `version`。
先确认它的修改时间是本次构建，别装到上一次的旧包。

1. **安装前先检查发布版是否在运行**。用 PowerShell 工具按 CommandLine 区分：
   只有 `C:\Users\xiang\AppData\Local\CodeDock\codedock.exe` 是发布版；
   `src-tauri\target\debug\codedock.exe` 是 dev 版，**别动**。
   - **没在运行**：直接进入第 2 步。
   - **在运行**：**用 AskUserQuestion 问用户要不要关闭它，不要擅自关**。
     - 用户同意关闭 → 用 `(Get-Process -Id <pid>).CloseMainWindow()` 走窗口关闭流程（子进程会被回收，比 taskkill 干净），确认进程真的退出了再继续。若关窗后进程仍驻留（应用收进托盘时不退出），把情况告诉用户，请用户手动退出后再继续。
     - 用户拒绝 → 停下报告，**不要安装**。
2. 静默安装（安装器是 currentUser 模式，不弹 UAC）。用 **PowerShell 工具**执行（Windows 一律走 PowerShell，别用 Bash）：

   ```powershell
   & "<安装包绝对路径>" /S
   ```

   等它结束并确认退出码为 0（`$LASTEXITCODE`）。
   用 PowerShell 不必管 `MSYS_NO_PATHCONV`；之所以强调别用 Git Bash，就是 Git Bash 会把 `/S` 当路径转成 `C:/Program Files/Git/S`，安装器收不到静默参数、弹出图形安装界面卡住。
3. 报告结果：安装位置 `%LOCALAPPDATA%\CodeDock\codedock.exe`、装进去的版本号与构建标识（即 2c 校验通过的那个）。**不要自动启动应用**，让用户自己开。

补充：安装器在静默模式下自身也会用 RestartManager 关掉占用该 exe 的进程；第 1 步先问用户、走优雅关闭，是为了不擅自打断用户正在进行的会话。
