---
description: "读一条 Gitee issue，按它的需求修改本仓库代码并验证"
allowed-tools: Bash, Read, Edit, Write, Grep, Glob, TaskCreate, TaskUpdate
---

**这条命令只做「读 issue → 改代码 → 验证」**，**不自动提交、不 push、不评论、不关 issue**——这几件都等用户明确发话。

**任一步失败就停下来贴原始错误，不要跳步往下走。**

## 1. 拿到编号并读 issue

编号从用户随命令给出的文字里取；没给就按上下文里最近提到的一条（刚 `/gitee-issue-list` / `/gitee-issue-add` 的结果）；仍不确定就问用户，**别猜**。

用 Bash 工具跑（**不传 `-R`**，仓库跟着当前目录的 git remote 推断）：

```bash
gitee issue view <number> --no-tui -j=number,title,state,body,html_url,labels
```

- `state` 不是 `open` 就先告诉用户「这条已关闭」，问清是否仍要按它改，别默默动手。
- 读不到（没装 / 没登录 / 编号不存在 / 网络）**原样贴出错误**，停下，不要自己编内容，也不要退回网页抓取。

## 2. 复述需求、定改动范围

- 把 issue 的诉求用一两句复述给用户，确认理解没跑偏。
- 用 Grep / Glob / Read 在本仓库定位相关代码（记得用 Explore 之类先摸清现状，别盲目改）。
- **范围大、有多种做法、或需求本身有歧义 → 先给方案让用户拍板再动手**；明确的小改直接做。

## 3. 改代码

按 issue 的诉求改，遵守 `AGENTS.md` 的全部约定（跨平台差异、注释用中文写「为什么」、只改被要求的地方、配色走语义类、设置项/后端命令五处联动等）。

## 4. 验证

前端改完至少 `pnpm build`（Vite dev 不做类型检查）；后端跑 `cd src-tauri && cargo test --lib` 和 `cargo clippy`；界面改动走 `scripts/cdp-check.cjs`。验证环境的坑见 `AGENTS.md` 的「验证」一节。

## 5. 报告与收尾

- 说清改了哪些文件、怎么改的、验证结果如何。
- 然后**问用户**要不要在 issue 上留一条进展评论、要不要用 `/gitee-issue-close` 关闭它；**提交与推送也等用户发话**。
