---
description: "本地构建安装：构建安装包 → 装到本机（不 push）"
allowed-tools: Bash, PowerShell, Read, Grep, Glob, TaskCreate, TaskUpdate, AskUserQuestion
---

按顺序执行下面两步。**任一步失败就停下来报告原因，不要跳步往下走。** 全程只做构建 / 安装，不改任何源代码。

**前置条件：工作区必须干净。** 有未提交改动就停下报告，让用户先走 `/git-commit`——或用
`/commit-ship-local` 把提交和本命令串起来跑。**不要**带着未提交改动构建（否则产物带 `.dirty`、装上去的东西和提交对不上）。

开工前先用 TaskCreate 建两条待办：`构建安装包` / `装到本机`。每进入一步就把它置为 `in_progress`、做完置 `completed`；失败时保持 `in_progress` 并报告，别标记完成。

## 0. 命令环境（先按系统选对再动手）

`pnpm` / `node` 一类的命令在三端的可用 shell 不一样，选错要么直接崩、要么拿不到环境。**每一步开始前先确认当前系统，再用对应环境执行**：

- **Windows**：一律用 **PowerShell 工具**，别用 Bash。Git Bash（MSYS）下 Node 设进程标题会撞 `Assertion failed: process_title, file src\win\util.c`，`pnpm build` 一启动就整个挂掉，根本跑不到真正的构建。
- **macOS**：用 **zsh**——命令包一层 `zsh -lc '<cmd>'`，跟 GUI 进程的 login shell 环境保持一致（Node / pnpm / cargo 常靠 `~/.zprofile` 里的 PATH）。
- **Linux**：用系统**默认 shell**（Bash 工具直接跑即可）。

下文凡是给出 shell 片段的地方，**Windows 看 PowerShell 版、macOS/Linux 看 Bash 版**；只给一份的时候默认是 Bash，macOS 上记得包 `zsh -lc`。

## 1. 构建安装包

*（进入本节先把「构建安装包」标为 `in_progress`，完成后再标 `completed`。）*

### 1a. 构建前校验

先确认工作区干净，再记下当前 HEAD：

```
git status --porcelain
git rev-parse --short HEAD
```

`git status --porcelain` **必须一行输出都没有**。有输出说明还有未提交改动——先停下报告，让用户走
`/git-commit`（或改用 `/commit-ship-local`），**不要**带着未提交改动构建。

### 1b. 构建

本项目**只为本机出包**，三端的产物各不相同，`--bundles` 选错会白编译一遍。按当前系统选：

- **Windows**：`nsis`（msi/WiX 对本机安装没用，跳过省时间）。
  ```
  pnpm tauri build --bundles nsis
  ```
- **macOS**：`app`（只要可运行的 `.app`，dmg 还得额外打包、对本地安装没有用）。
  ```
  zsh -lc 'pnpm tauri build --bundles app'
  ```
- **Linux**：先按发行版选包类型，再只构建那一种（**不要**图省事出 `all`，deb + rpm + AppImage 全编会显著拉长构建）。
  ```
  . /etc/os-release 2>/dev/null
  case "${ID:-} ${ID_LIKE:-}" in
    *debian*|*ubuntu*)       bundle=deb ;;
    *rhel*|*fedora*|*centos*|*suse*) bundle=rpm ;;
    *)                       bundle=appimage ;;
  esac
  echo "bundle=$bundle"
  pnpm tauri build --bundles "$bundle"
  ```
  用**第 0 步选定的环境**、**后台**跑；release 编译很慢，不要放前台等。

- **后台任务要给足超时**：release 编译远超工具默认的 2 分钟，跑后台时显式带上 `timeout`（如 600000ms），否则会在编译中途被掐断、误判成构建失败。
- `tauri.conf.json` 的 `beforeBuildCommand` 已包含 `pnpm build`（tsc + vite），**不要**再单独跑一遍前端构建。
- 命令行参数不改仓库配置，正常发版仍是全量（`targets: "all"`）。
- 类型错误、rust 编译失败就停下报告，别继续装。

### 1c. 构建后校验

Vite 会把 `<version>+<git 短 hash>[.dirty]` 注入前端产物，核对它和当前 HEAD 是否一致（防止装到用旧 commit 构建的包）。

**macOS / Linux（Bash）**：
```
expected="$(node -p "require('./package.json').version")+$(git rev-parse --short HEAD)"
actual="$(grep -ohE '[0-9]+\.[0-9]+\.[0-9]+\+[A-Za-z0-9._-]+' dist/assets/*.js | sort -u)"
echo "expected=$expected"; echo "actual=$actual"
```

**Windows（PowerShell）**：
```powershell
$expected = (node -p "require('./package.json').version") + "+" + (git rev-parse --short HEAD)
$actual = (Select-String -Path dist/assets/*.js -Pattern '[0-9]+\.[0-9]+\.[0-9]+\+[A-Za-z0-9._-]+' -AllMatches |
  ForEach-Object { $_.Matches.Value } | Sort-Object -Unique) -join ' '
"expected=$expected"; "actual=$actual"
```

- 两者**必须相等**，且 `actual` 只应有一个值。不一致就停下报告，**不要**继续安装——说明 dist 是旧的，或构建用的不是当前 commit。
- 出现 `.dirty` 后缀同样算失败。
- 把通过校验的标识记下来，第 2 步报告时用。

## 2. 装到本机

*（进入本节先把「装到本机」标为 `in_progress`，完成后再标 `completed`。）*

`<version>` 取 `package.json` 的 `version`。**先确认产物的修改时间是本次构建**，别装到上一次的旧包。三端产物与安装方式如下，只做当前系统那一条。

### 2a. 安装前先检查发布版是否在运行

跑着的进程会占用旧文件，覆盖安装可能失败或让用户手上的会话突然断掉。**先判断再问，不要擅自关**：

- **没在运行**：直接进入对应系统的安装步骤。
- **在运行**：**用 AskUserQuestion 问用户要不要关闭它**。
  - 用户同意 → 走**优雅退出**（确认进程真的退了再继续）；关不掉（比如应用收进了托盘）就把情况告诉用户，请其手动退出。
  - 用户拒绝 → 停下报告，**不要安装**。

识别发布版进程（别误伤 dev 版）：

- **Windows（PowerShell）**：按 CommandLine 区分，只有 `C:\Users\xiang\AppData\Local\CodeDock\codedock.exe` 是发布版；`src-tauri\target\debug\codedock.exe` 是 dev 版，**别动**。关闭用 `(Get-Process -Id <pid>).CloseMainWindow()`（子进程会被回收，比 taskkill 干净）。
- **macOS（Bash）**：`pgrep -f 'CodeDock.app/Contents/MacOS'`。关闭用 `osascript -e 'quit app "CodeDock"'`。
- **Linux（Bash）**：`pgrep -af codedock`，过滤掉路径里带 `target/debug` 的 dev 版。关闭用 `pkill -TERM -f '/usr/bin/codedock|codedock.AppImage'`。

### 2b. Windows

产物：`src-tauri/target/release/bundle/nsis/CodeDock_<version>_x64-setup.exe`（x64 以外架构文件名里的后缀不同，按实际取）。

静默安装（安装器是 currentUser 模式，不弹 UAC）。用 **PowerShell 工具**执行（Windows 一律走 PowerShell，别用 Bash）：

```powershell
& "<安装包绝对路径>" /S
```

等它结束并确认退出码为 0（`$LASTEXITCODE`）。
用 PowerShell 不必管 `MSYS_NO_PATHCONV`；之所以强调别用 Git Bash，就是 Git Bash 会把 `/S` 当路径转成 `C:/Program Files/Git/S`，安装器收不到静默参数、弹出图形安装界面卡住。

安装位置：`%LOCALAPPDATA%\CodeDock\codedock.exe`。

### 2c. macOS

产物：`src-tauri/target/release/bundle/macos/CodeDock.app`。

在 **Bash** 里执行（macOS 上包 `zsh -lc`）：

```
src="src-tauri/target/release/bundle/macos/CodeDock.app"
dst="/Applications/CodeDock.app"
rm -rf "$dst" && cp -R "$src" "$dst"
# 本地包没签名，不去隔离属性 Gatekeeper 会直接拦下不让开
xattr -dr com.apple.quarantine "$dst"
```

- `rm -rf "$dst"` 只针对 `/Applications/CodeDock.app` 这一个路径，且前置条件已确认进程退出；**不要**把变量换成 `/Applications`。
- 覆盖安装前若 `/Applications/CodeDock.app` 不存在，`rm -rf` 是空操作，不用特判。
- 安装位置：`/Applications/CodeDock.app`。

### 2d. Linux

按 1b 选定的 `bundle` 走对应分支。**deb / rpm 走系统包管理器、需要 sudo**（会提示输密码，别静默吞掉失败）；AppImage 不需要 sudo。

- **deb**（产物 `src-tauri/target/release/bundle/deb/CodeDock_<version>_<arch>.deb`）：
  ```
  sudo dpkg -i src-tauri/target/release/bundle/deb/CodeDock_<version>_<arch>.deb
  # 缺依赖时补装，再确认一遍
  sudo apt-get -f install -y
  ```
- **rpm**（产物 `src-tauri/target/release/bundle/rpm/CodeDock-<version>-1.<arch>.rpm`）：
  ```
  sudo dnf install -y src-tauri/target/release/bundle/rpm/CodeDock-<version>-1.<arch>.rpm
  ```
  没有 dnf 的发行版换 `sudo rpm -Uvh --replacepkgs <包>`。
- **appimage**（产物 `src-tauri/target/release/bundle/appimage/CodeDock_<version>_<arch>.AppImage`）：
  ```
  install -Dm755 src-tauri/target/release/bundle/appimage/CodeDock_<version>_<arch>.AppImage \
    ~/.local/bin/codedock.AppImage
  ```
  确认 `~/.local/bin` 在 PATH 里；不在就提示用户（本命令**不改**用户的 shell 配置）。

- 安装位置：deb / rpm 装到 `/usr/bin/codedock`，AppImage 是 `~/.local/bin/codedock.AppImage`。

### 2e. 报告

报告安装位置（见各小节末尾）、装进去的版本号与构建标识（即 1c 校验通过的那个）。**不要自动启动应用**，让用户自己开。

补充：Windows 安装器在静默模式下自身也会用 RestartManager 关掉占用该 exe 的进程；2a 先问用户、走优雅关闭，是为了不擅自打断用户正在进行的会话。macOS / Linux 的覆盖安装不会自动收掉旧进程，2a 的检查更不能省。
