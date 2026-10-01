---
description: "按本项目的提交习惯把改动提交到本地（按变更主体归类、中文 Conventional Commits，不 push）"
allowed-tools: Bash, Read, Grep, Glob
---

**只做本地提交**：不 `git push`、不开 PR、不推分支——都等用户明确发话（见 `AGENTS.md`）。

**任一步失败就停下来贴原始错误，不要跳步往下走。**

## 1. 摸清现状

```bash
git status
git diff                 # 未暂存
git diff --cached        # 已暂存
git log --oneline -20    # 对齐最近的提交风格
```

**通读全部改动**再动手，别只扫文件名。已经暂存的东西也不要无脑沿用——本项目要求按变更主体归类，可能需要重新切。

## 2. 按变更主体归类（核心）

先给所有改动**分类**，再决定切成几条——**同一类的放一批**。既不是「一个文件一条」，也不必细到「一事一条」。别一把 `git add -A` 合成一个大提交。

- 类别按**变更主体**划：命令脚本（`.codebuddy/commands/`、`scripts/`）、后端命令、前端接线、文档、构建依赖……**同类的多个文件、多个 hunk 归成一条提交**。
- 例：`.codebuddy/commands/` 下两个命令做了同一类改动（都给命令补 macOS / Linux 支持）→ 合成一条 `chore(commands): ...`，不拆成两条。
- **只在类别互不相干时才拆**（比如后端的 `fix` 和纯文档的 `docs`）；一条提交的标题怎么也概括不全，说明该拆。
- 同一文件里跨类别的 hunk 用 `git apply --cached` 手工切：先暂存靠前的类别，剩下的用 `git diff` 自然得到。
- 纠缠到拆不开的（同一 hunk 内两类改动行交错）就并成一条，并在正文里说明。
- 只有一类改动时，一条就够了——不要为了凑数硬拆。

## 3. 提交信息格式

**中文 Conventional Commits**：`type(scope): 标题`，标题单行、简洁，说清做了什么。

- `type`：`feat`（新功能）/ `fix`（修复）/ `refactor`（重构）/ `style`（样式、格式）/ `docs`（文档）/ `chore`（杂务、构建、命令脚本）。
- `scope`：动到的模块，小写。参考：`explorer`（文件树）/ `sidebar` / `settings` / `theme` / `terminal` / `git`（变更）/ `search` / `editor`（编辑器）/ `browser` / `agent`（智能体）/ `workspace`（工作区模型）/ `backend`（Rust 通用）/ `installer`（依赖）/ `cli` / `commands`（`.codebuddy` 命令）/ `readme`；确实跨多块或不好归类的可以省略 scope。
- 标题语言和历史一致（中文）；**正文可选**，用来说**为什么**这么改、踩了哪个坑，不重复标题里已说的「做了什么」。

提交用 HEREDOC，避免引号与换行出问题：

```bash
git add <该类别的文件> && git commit -m "$(cat <<'EOF'
type(scope): 中文标题

正文写为什么（可选）。
EOF
)"
```

## 4. 收尾

- **该验证的验证完再提交**：前端 `pnpm build`、后端 `cd src-tauri && cargo test --lib`（+ `cargo clippy`）、界面改动走 `scripts/cdp-check.cjs`。没验证过的改动先别提交。
- 报告分了几条、每条 `hash + 标题`，并说明**改动留在本地、未 push**；要推到远程走 `/git-push`。
- 绝不 `--amend`、绝不 `--no-verify`、绝不动 git config。
