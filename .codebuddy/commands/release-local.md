---
description: "本地发布：提交改动 → 构建 NSIS 安装包 → 装到本机（不 push）"
allowed-tools: Bash, PowerShell, Read, Grep, Glob
---

按顺序执行下面三步。**任一步失败就停下来报告原因，不要跳步往下走。** 全程只做提交 / 构建 / 安装，不改任何源代码。

## 1. 提交改动（规则同 /commit）

先 `git status --short` 并通读完整 diff，然后**按主题拆成多个 commit**，不要 `git add -A` 合成一条：

- 按功能切主题（后端命令 / 前端接线 / 文档各自成题），不按文件、不按时间切。
- 同一文件里不同主题的 hunk 用 `git apply --cached` 手工切；同一 hunk 内两个主题交错的可以并成一条，并在提交信息里说明。
- 纯文档更新单独一条 `docs:` 提交。
- 提交信息用 Conventional Commits（`feat` / `fix` / `chore` / `docs` …）。
- **只提交，不 push**——push 要用户明确同意。
- 工作区本来就干净时跳过本节。

## 2. 构建安装包

用 Bash 工具**后台**跑（release 编译很慢，不要放前台等）：

```
pnpm tauri build --bundles nsis
```

- `tauri.conf.json` 的 `beforeBuildCommand` 已包含 `pnpm build`（tsc + vite），**不要**再单独跑一遍前端构建。
- 这里只出 NSIS 包（msi/WiX 对本机安装没用，跳过省时间）。命令行参数不改仓库配置，正常发版仍是全量。
- 类型错误、rust 编译失败就停下报告，别继续装。

## 3. 装到本机

产物：`src-tauri/target/release/bundle/nsis/CodeDock_<version>_x64-setup.exe`，`<version>` 取 `package.json` 的 `version`。
先确认该产物的修改时间是本次构建，别装到上一次的旧包。

1. **关掉正在运行的发布版**（不关装不进去）。用 PowerShell 工具按 CommandLine 区分：
   只有 `C:\Users\xiang\AppData\Local\CodeDock\codedock.exe` 是发布版、要关；
   `src-tauri\target\debug\codedock.exe` 是 dev 版，**别动**。
   关闭用 `(Get-Process -Id <pid>).CloseMainWindow()` 走窗口关闭流程（子进程会被回收，比 taskkill 干净），然后确认进程真的退出了再继续。
2. 静默安装（安装器是 currentUser 模式，不弹 UAC）：

   ```
   "<安装包绝对路径>" /S
   ```

   等它结束并确认退出码为 0。
3. 报告结果：安装位置 `%LOCALAPPDATA%\CodeDock\codedock.exe`、装进去的版本号。**不要自动启动应用**，让用户自己开。

补充：安装器在静默模式下自身也会用 RestartManager 关掉占用该 exe 的进程；第 1 步是为了让它走优雅关闭，两者不冲突。
