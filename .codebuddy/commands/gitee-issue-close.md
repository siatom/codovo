---
description: "关闭 Gitee 上的一条 issue（按编号，关闭前先确认）"
allowed-tools: Bash
---

从用户随命令给出的文字里拿**编号**（也可以是从上一条 `/gitee-issue-list` 结果里指的那条）。

- 用户只给了标题、没给编号：先用 Bash 跑 `gitee issue list -s open --no-tui -l 100 -j=number,title,state` 找匹配的编号。
  **标题匹配到多条或匹配不上就别猜**——列出来让用户挑一条，再往下走。
- 编号拿到后，**关闭前把要关的那条（编号 + 标题）给用户确认一次**；用户明确说「直接关 / 不用确认」才跳过。

用 Bash 工具跑（**不传 `-R`**，仓库跟着当前目录的 git remote 推断）：

```bash
gitee issue close <number>
```

然后：

- 成功后报告关了哪一条（编号 + 标题），`-j` 有输出就一并带上。
- 命令失败（没装 / 没登录 / 缺 scope / 不在 git 仓库 / 网络）**原样贴出错误**，不要自己编内容，也不要退回网页操作。
- 只做关闭：不评论、不改标题、不删 issue。
