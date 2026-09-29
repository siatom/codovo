---
description: "列出本项目在 Gitee 上处于 open 状态的 issue"
allowed-tools: Bash
---

用 Bash 工具跑（**不传 `-R`**，仓库跟着当前目录的 git remote 推断，写死仓库名换仓库就漂了）：

```bash
gitee issue list -s open --no-tui -l 100 -j=number,title,state,html_url,created_at
```

然后：

- 把返回的 JSON 整理成一张表展示——编号 / 标题 / 创建时间 / 链接；时间从 ISO（`2026-09-29T12:42:05+08:00`）裁成 `2026-09-29 12:42`。CLI 默认按创建时间倒序，不用再排。
- 结果是空数组就直说「当前没有打开的 issue」。
- 命令失败（没装 / 没登录 / 不在 git 仓库 / 网络）**原样贴出错误**，不要自己编内容，也不要退回网页抓取。
- 只读操作：不创建、不修改、不关闭任何 issue。
