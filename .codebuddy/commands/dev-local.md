---
description: "本地开发构建：提交改动 → 构建 dev（debug）可执行文件，不打包、不安装"
allowed-tools: Bash, PowerShell, Read, Grep, Glob, TaskCreate, TaskUpdate
---

按顺序执行下面三步。**任一步失败就停下来报告原因，不要跳步往下走。** 全程只做提交 / 构建 / 确认，不改任何源代码。

开工前先用 TaskCreate 建三条待办：`提交改动` / `构建 dev` / `确认产物`。每进入一步就把它置为 `in_progress`、做完置 `completed`；失败时保持 `in_progress` 并报告，别标记完成。

## 1. 提交改动（规则同 /commit）

*（进入本节先把「提交改动」标为 `in_progress`，完成后再标 `completed`。）*

先 `git status --short` 并通读完整 diff，然后**按主题拆成多个 commit**，不要 `git add -A` 合成一条：

- 按功能切主题（后端命令 / 前端接线 / 文档各自成题），不按文件、不按时间切。
- 同一文件里不同主题的 hunk 用 `git apply --cached` 手工切；同一 hunk 内两个主题交错的可以并成一条，并在提交信息里说明。
- 纯文档更新单独一条 `docs:` 提交。
- 提交信息用 Conventional Commits（`feat` / `fix` / `chore` / `docs` …）。
- **只提交，不 push**——push 要用户明确同意。
- 工作区本来就干净时跳过本节。

## 2. 构建 dev

*（进入本节先把「构建 dev」标为 `in_progress`，完成后再标 `completed`。）*

### 2a. 构建前校验

先确认工作区干净，再记下当前 HEAD：

```
git status --porcelain
git rev-parse --short HEAD
```

`git status --porcelain` **必须一行输出都没有**。有输出说明第 1 步没提交干净——回去补提交，**不要**带着未提交改动构建（否则产物带 `.dirty`、产出的东西和提交对不上）。

### 2b. 构建

用 Bash 工具**后台**跑（别放前台等）：

```
pnpm tauri build --debug --no-bundle
```

- `--debug` 出 debug 版（编译快、带调试信息），产物是 `src-tauri/target/debug/codedock.exe`。
- `--no-bundle` 跳过打包——dev 版在本机直接跑，不需要 NSIS/MSI 安装包。
- `tauri.conf.json` 的 `beforeBuildCommand` 已包含 `pnpm build`（tsc + vite），**不要**再单独跑一遍前端构建。
- 类型错误、rust 编译失败就停下报告。

### 2c. 构建后校验

Vite 会把 `<version>+<git 短 hash>[.dirty]` 注入前端产物，核对它和当前 HEAD 是否一致（防止产物是旧 commit 编的）：

```
expected="$(node -p "require('./package.json').version")+$(git rev-parse --short HEAD)"
actual="$(grep -ohE '[0-9]+\.[0-9]+\.[0-9]+\+[A-Za-z0-9._-]+' dist/assets/*.js | sort -u)"
echo "expected=$expected"; echo "actual=$actual"
```

- 两者**必须相等**，且 `actual` 只应有一行。不一致就停下报告，说明 dist 是旧的或构建用的不是当前 commit。
- 出现 `.dirty` 后缀同样算失败。
- 把通过校验的标识记下来，第 3 步报告时用。

## 3. 确认产物

*（进入本节先把「确认产物」标为 `in_progress`，完成后再标 `completed`。）*

1. 确认 `src-tauri/target/debug/codedock.exe` 存在，且修改时间是本次构建（别拿上一次的旧产物）。
2. 报告：产物绝对路径 / 大小 / 修改时间、构建标识（2c 校验通过的那个）。**不要自动启动它**，交给用户。
