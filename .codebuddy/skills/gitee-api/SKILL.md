---
name: gitee-api
description: 用 Gitee REST API 操作仓库（issue 列表/详情/评论/关闭、标签等）时使用。包含本项目私有仓库的令牌位置与实测过的正确调用；遇到任何 API 用法不确定时，必须先查官方 swagger 再动手。
allowed-tools: Bash, Read, WebFetch
---

# Gitee API 操作

本仓库 `silicon-atom/code-dock` 是私有仓库，issue 等操作一律走 Gitee REST API v5。

## 第一条规矩：拿不准就查官方 swagger

**不要凭记忆拼接口路径。** 任何调用不确定时，先查：

https://gitee.com/api/v5/swagger

最有用的线索是**锚点名**——它就是「方法 + 路径段」拼出来的，可以直接反推路径：

- `#/patchV5ReposOwnerIssuesNumber` → `PATCH /v5/repos/{owner}/issues/{number}`
- `#/postV5ReposOwnerRepoIssuesNumberComments` → `POST /v5/repos/{owner}/{repo}/issues/{number}/comments`

锚点里**出现的每一段**（有没有 `Repo` 段）都对应真实路径，多一段少一段都会 404。

swagger 是 JS 渲染的，WebFetch 通常只能拿到参数表；拿不到细节就按锚点推断 + 实测。也可以直接搜「接口名 + 报错信息」，社区答案往往更快。

## 令牌

存在**项目根 `.env` 的 `GITEE_TOKEN`**（已被 `.gitignore` 忽略：不要提交，也不要写进命令或对话）。每次用之前读进来：

```bash
cd <项目根> && set -a && . ./.env && set +a
```

token 的 scope 决定能干什么：读 issue 要 `issues`，**发评论要 `notes`**（缺了回 `401 Unauthorized: no 'notes' scope'`），改 issue 状态要 `issues`。权限不够就让用户去 https://gitee.com/profile/personal_access_tokens 补勾，别自己试。

## 实测可用的调用

基址：`https://gitee.com/api/v5/repos/silicon-atom/code-dock`

| 动作 | 调用 |
|---|---|
| 列 issue | `GET /issues?state=open&per_page=100&access_token=...` |
| issue 详情 | `GET /issues/{number}`（number 形如 `IKING7`，不是数字 id） |
| 发评论 | `POST /issues/{number}/comments`，body 用 `--data-urlencode "body=…"` |

**改 issue 状态（打开/关闭）走的不是同一个接口**，注意路径：

```bash
# 路径里没有 repo 段，仓库名放在 body 的 repo 参数里
curl -s -X PATCH "https://gitee.com/api/v5/repos/silicon-atom/issues/IKING7" \
  -d "state=closed" -d "repo=code-dock" -d "access_token=$GITEE_TOKEN"
```

这个接口最坑：写成带 repo 段的 `/repos/{owner}/{repo}/issues/{number}` 会回
`404 project or enterprise`（form / JSON body / query token / 数字 id 全试过都不行），
`PUT` / `POST` 一律 `405 Not Allowed`。

## 回报习惯

- 失败时要把**完整响应 body** 读出来再判断——Gitee 常用 404 掩盖真实原因，`message` 字段才是线索。
- 别急着断定「令牌缺权限」：先核对路径段是否和 swagger 锚点一致。（踩过：明明是路径多了 `Repo` 段，却误判成缺 scope，白试了六种传参。）
- 处理完 issue 后按用户要求更新/关闭，并把关键结论同步到 issue 评论里。
