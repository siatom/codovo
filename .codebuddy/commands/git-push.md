---
description: "把本地提交批量推送到远程（默认不推 tag、绝不 force）"
allowed-tools: Bash, Read, Grep, Glob
---

**运行这个命令本身就是「用户明确允许 push」**——除它之外一律不主动 push（见 `AGENTS.md`）。
**绝不 `--force` / `--force-with-lease`，绝不改 git config，绝不开 PR。**

**任一步失败就停下来贴原始错误，不要跳步往下走。**

## 1. 先看清要推什么

```bash
git status --short
git branch --show-current
git log --oneline @{u}..HEAD 2>/dev/null || echo "(没有 upstream)"
git log --oneline -5
```

- 工作区不干净（`git status --short` 有输出）先告诉用户「还有未提交的改动」，问清是**先就地提交**还是要照推——**不要替用户提交**（提交走 `/git-commit`）。
- 没有 upstream 的分支，push 时要带 `-u`。
- 在 detached HEAD 上不给推，直接停下说明。

## 2. 判断能不能推

```bash
git rev-list --count HEAD..@{u}   # 落后远端的提交数（没有 upstream 时跳过）
```

- **落后数非 0**：本地和远端分叉了。停下、如实报告，让用户自己决定 merge / rebase / 放弃——**绝不 force**。
- **领先数为 0**：告诉用户「没有要推的提交」，什么都不做。
- 只推当前分支。**不** `git push --all`、不顺手推别的分支。

## 3. 推

```bash
git push                      # 已有 upstream
git push -u origin <branch>   # 首次推这个分支
```

- **默认不带 `--tags`**：tag 是发版里程碑，走 `pnpm version patch|minor|major` 那条线，这里不顺手推。
- 只有用户明确要求，才用 `git push --follow-tags` 连 tag 一起推。
- 推送前若**没跑过验证**（前端 `pnpm build`、后端 `cargo test --lib`），提醒一句；别默认它是验证过的。

## 4. 收尾

- 报告推了哪几条 commit（`hash + 标题`）、推到了哪个远端分支，以及当前是否已与远端同步。
- 任何一步失败原样贴错误，不要用强推、跳过钩子之类的方式硬来（`--no-verify` 一律不用）。
