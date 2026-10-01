---
description: "从远程拉取更新到当前分支（保守：仅快进，分叉就停下报告）"
allowed-tools: Bash, Read, Grep, Glob
---

**只拉当前分支、只做快进**：不 `--rebase`、**绝不 `--force`**、**绝不改 git config**、**绝不丢弃本地改动**。
**任一步失败就停下来贴原始错误，不要跳步往下走。**

## 1. 先看清现状

```bash
git status --short
git branch --show-current
git fetch
git log --oneline -5
git log --oneline @{u}..HEAD 2>/dev/null || echo "(没有 upstream)"
git log --oneline HEAD..@{u} 2>/dev/null || echo "(没有 upstream)"
```

- 在 detached HEAD 上不拉，直接停下说明。
- 没有 upstream：停下，问用户是否要 `git pull origin <branch>`，别自作主张。
- 工作区不干净（`git status --short` 有输出）：pull 会被拒或有风险。**停下报告**未提交的改动，让用户决定先提交（`/git-commit`）、stash 还是放弃——**不要替用户 stash 或丢弃**。

## 2. 判断能不能拉

- 远端领先数为 0：告诉用户「已是最新」，什么都不做。
- 本地领先且远端也领先：**分叉了**。停下、如实报告，让用户自己决定 merge / rebase / 放弃——不要在这里替用户合并。
- 只落后（本地领先数为 0）：可以拉。

## 3. 拉

```bash
git pull --ff-only
```

- **默认 `--ff-only`**：能快进才动，需要合并就报错停下——把决定权留给用户。
- 只有用户明确要求，才用 `git pull`（允许产生 merge commit）。
- 不顺手 `--rebase`、不 `--prune`、不拉别的分支。

## 4. 冲突 / 失败

- 一旦产生冲突或非快进被拒：**停下**，用 `git status` 列出冲突 / 受阻文件，原样贴错误，**不要自动解决**，也不要擅自 `git merge --abort` / `git rebase --abort`。
- 任何一步失败都原样贴错误，不要用强拉、跳过钩子之类的方式硬来。

## 5. 收尾

- 报告拉进来的 commit（`hash + 标题`）、当前分支与远端是否同步。
- 提醒：拉下来的改动若动了 `src-tauri/*.rs`，dev 会自动重编重启；前端改动会触发 HMR 重载（终端重置、编辑器清空）——用 CodeDock 开发 CodeDock 时留意。
