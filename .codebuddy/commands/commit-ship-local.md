---
description: "本地发版：先按 /git-commit 提交，等确认后走 /ship-local 构建并安装到本机（不 push）"
allowed-tools: Bash, PowerShell, Read, Grep, Glob, TaskCreate, TaskUpdate, AskUserQuestion
---

把「提交」和「构建安装」串成一条流程。**两条命令各自怎么做、规则是什么，全在它们自己的文档里——
本命令只负责按顺序调用、不重复任何规则。**

开工前先用 TaskCreate 建两条待办：`提交改动` / `构建安装`。每进入一步就把它置为 `in_progress`、做完置 `completed`；失败时保持 `in_progress` 并报告，别标记完成。

## 1. 提交改动

*（先把「提交改动」标为 `in_progress`。）*

按 **`/git-commit`** 执行——它负责按变更主体归类、写中文 Conventional Commits、只提交不 push。
**分类 / 切 hunk / 提交信息格式一律以它为准，别在这里另起口径。**

- 工作区本来就干净：跳过本节，直接进第 2 步。
- 提交完**先停下**，把结果（分了几条、每条 hash + 标题）报给用户，**等用户确认后再进第 2 步**——
  不要一口气把提交和构建连做完。

完成后把「提交改动」标为 `completed`。

## 2. 本地构建安装

*（先把「构建安装」标为 `in_progress`。）*

按 **`/ship-local`** 执行——它负责构建安装包 → 校验构建标识 → 装到本机。
构建类型、校验方式、安装步骤全部以它为准；它要求的「前置条件：工作区干净」在第 1 步之后自然满足。

完成后把「构建安装」标为 `completed`，并按 `/ship-local` 的收尾报告安装位置、版本号与构建标识。
