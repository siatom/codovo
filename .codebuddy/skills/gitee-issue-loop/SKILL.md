---
name: gitee-issue-loop
description: >-
  「审查建单 → 领单 → worktree 修复 → 提交推送 → 评论关闭」的 Gitee issue 闭环。
  A 段：通读代码找功能缺口与 bug，按 feature / enhancement / bug 分类批量提 Gitee issue；
  B 段：拉取 open issue，逐条在独立 git worktree 里修复并验证，自动 commit、`--no-ff` 合并回 main
  再 push（**特性分支只留本地、不推远程**），最后补评论并关闭 issue。当用户要「检查代码提改进项」「批量建 issue」
  「拉 issue 修一批」「分 worktree 修 issue 并自动提交」时使用。单条建单 / 修复 / 关闭仍可走
  `/gitee-issue-add`、`/gitee-issue-fix`、`/gitee-issue-close`。
---

# Gitee issue 闭环

两段可独立、也可首尾相接：**A 审查建单**、**B 领单修复**。修复段**按落点分组、派 subagent 执行**
（落点重叠的 issue 合给同一个 subagent，互不重叠的组才并行），主线程只做编排。B 段的每一步都可交给仓库里已有的
斜杠命令（`/gitee-issue-list` `/gitee-issue-fix` `/gitee-issue-close` `/git-commit` `/git-push`），
本技能的价值在**把它们串成一条自动跑通的流水线**，尤其是 worktree 这块——照 AGENTS.md 默认是
「不 push、等确认」，这里因为用户点了本技能而**一次性授权**修复段的 commit / push / 合并 / 评论 / 关闭。
但**建单前仍要停下来等用户确认**；A 段接着跑 B 段时，修复范围就用 A 段刚建的这批 issue，段间不再停（见第 0 节）。

## 0. 授权与总原则

**只有建单前这一处必须等用户确认，其余自动：**

- **建单前先确认**（第 2.3 节）：起草好的标题 / 正文 / 标签先给用户过目，**等用户明确点头才 `create`**。
  用户可能要求改，改完再确认一次。
- **A 段 → B 段之间不再停**：A 段建完后直接接着跑 B 段，修复范围默认就是 A 段刚建的这批 issue。
  只有**单独**跑 B 段（不是紧接一次 A 段）时，才按第 3 节问清修哪几条。

除此之外，**调用本技能即视为用户授权**：对本流程新建的 `feat/*` `fix/*` 分支及其对应 issue，
自动 commit / `--no-ff` 合并回 main / push main / 评论 / 关闭，不再逐步等确认。
**特性分支只留本地、不推远程**——合并进 main 后连同分支一起在本地删掉（见 5.2、第 7 节）。

这条授权**只覆盖本流程创建的分支与 issue**，不延伸。仍然永不：`--force` / `--no-verify` /
改 git config / 推 tag / 开 PR / `git push --all` / 推特性分支 / 碰安装版 CodeDock。

## 1. 前置检查

```bash
gitee auth token          # 有输出 = 已登录（本机已配）
git status --short        # 要干净；有改动先问用户怎么处理，别顺手提交
git fetch origin
git worktree list         # 看清现有 worktree，别撞名
```

- **命令一律不传 `-R`**：仓库跟随当前目录 git remote 推断。
- 仓库已有标签：`feature`（新能力）/ `enhancement`（现有功能改进）/ `bug`（行为错误）。
  另有 duplicate / invalid / question / wontfix，本流程不用。
- `git status` 里出现自己没改过的文件（SplitPane / TerminalPane / icons…）说明**另一个会话正在同仓库干活**——
  别当自己的改动、别 `git checkout`，也少做整页 reload / 重启应用这类会打断对方的事。

## 2. 阶段 A：审查并建单

### 2.1 找改进点

派 Explore（范围大可并行几个）通读代码，产出候选清单。每条**必须**带：

- **落点**：文件路径 + 行号（真读到才算数，不许凭印象编）。
- **类别**：`feature` = 该有却还没有的能力；`enhancement` = 已有功能做得不够好；`bug` = 与预期不符 / 报错。
- **现状 → 期望**：一两句说清。

别只挑表面。至少扫一遍：跨平台差异、错误处理与边界条件、性能、可访问性，
以及**与 AGENTS.md 约定的偏离**（配色三处未对齐、设置项五处没联动、后端命令没在 `lib.rs` 注册…）。

### 2.2 起草 issue

**标题**：`[模块] 动词 + 对象 [+ 限定]`，压在一行内。模块取仓库已有说法（终端 / 编辑器 / 文件树 /
侧栏 / 右栏 / git / 智能体 / 设置 / 窗口…）；动词开头（添加 / 修复 / 支持 / 重构 / 优化）；
跨平台这类约束用「，」接在后面。别把正文分节标题搬进标题。

**正文**分节，只写有内容的小节：`## 背景` / `## 期望` / `## 实现要点（可选）` / `## 验收`。

判据必须基于实际读到的代码；引用了文件就带路径。摸不到落点时老实写「实现待定」，别编。

### 2.3 先确认，再批量提交

**必须等用户确认**：把定好的「标题 + 正文 + 标签」原样打给用户过目，然后**停下来等回复**。
用户没点头（或只说了「先看看」）之前**一条都不许建**。用户提出修改就改完再确认一次。

- 已经有编号的 issue 内容要变，用 `gitee issue edit <number> --labels ... -t ... -b ...` **更新原编号**，
  别关掉重建——编号是评论 / 提交信息里引用的锚点。
- 确认后逐条建：

```bash
gitee issue create -t "<标题>" -b "<正文>" --labels <feature|enhancement|bug> -j
```

- 标题/正文含引号、换行或特殊字符时用单引号、`$'...'` 或先塞进变量再传，别让 shell 吃掉。
- 从返回 JSON 取 `number` / `html_url`，最后汇总成表报告建了哪几条。
- 命令失败（没装 / 没登录 / 缺 scope / 不在仓库 / 网络）**原样贴错**，不编内容、不退回网页。
- 建单阶段**只建**：不改状态、指派、里程碑。

## 3. 阶段 B：拉取并筛选

```bash
gitee issue list -s open --no-tui -l 100 -j=number,title,state,labels,html_url,created_at
```

- 整理成表：编号 / 标签 / 标题 / 创建时间 / 链接；时间裁成 `YYYY-MM-DD HH:MM`。空数组就直说「没有打开的 issue」。
- 范围：A 段连跑过来的，直接用 A 段刚建的这批 issue，**不再问**；只有单独跑 B 段且用户没定范围时才问——
  全修，还是按 label（如只修 `bug`），还是指定编号。
- 每条开工前拉全文：
  ```bash
  gitee issue view <number> --no-tui -j=number,title,state,body,html_url,labels
  ```
  `state != open` 就跳过并说明，别默默动手。

## 4. 阶段 C：分组 + 派 subagent 修复

**修复阶段用 subagent 执行，但先分组再派**——分组按「改动落点是否重叠」定，不是一条 issue 一个 subagent。

### 4.0 先分组，再定 worktree / subagent

逐条读 issue 的落点（要改哪些文件 / 模块）后分组：

- **落点重叠的 issue 归一组**：改同一个文件的、改同一模块的、或一条依赖另一条的。
  同组**共用一个 worktree + 一个分支 + 一个 subagent**，由这个 subagent 一起改完——
  两个 subagent 并行改同一文件必然互相覆盖 / 制造冲突，要避免。
- **落点互不重叠的组才并行**：一组一个 worktree，一次性在同一条消息里派多个 Agent 并行跑。
- **一组只有一条 issue** 是常态；组里有多条时，分支名 / 合并提交按组取一个能概括全部的名称。

派 subagent 时（`subagent_type: general-purpose`，要能写文件）在 prompt 里给足：

- 这个组的 **worktree 绝对路径**、要修的 **issue 编号 + 正文原文**。
- 落点文件、`AGENTS.md` 的关键约定（跨平台、注释写「为什么」、只改被要求的地方）。
- 验证命令（下一节），并明确：**只在 worktree 里改，不 commit / 不 push / 不碰别的 worktree**——
  提交、推送、合并、评论、关闭统由主线程（你）来做，免得 subagent 各写各的提交、并发 push。
- 要求它回报：改了哪些文件、验证结果、遇到的问题。

### 4.1 建 worktree（每组一个）

```bash
cd D:/CodeProjects/code-dock        # 回主仓库
git fetch origin
git worktree add .codebuddy/worktrees/<topic> -b <fix|feat>/<topic> origin/main
```

- 分支名：`bug` → `fix/<topic>`，`feature`/`enhancement` → `feat/<topic>`；`<topic>` 用英文小写短横线。
- 目录放 `.codebuddy/worktrees/`（已被 `.gitignore` 忽略，不进提交）。

### 4.2 免装依赖（关键，别省）

给新 worktree 建一个指向主仓库 `node_modules` 的**目录联结**，用 PowerShell 工具：

```powershell
New-Item -ItemType Junction -Path "D:\CodeProjects\code-dock\.codebuddy\worktrees\<topic>\node_modules" -Target "D:\CodeProjects\code-dock\node_modules"
```

> 只有这条能用：`mklink` 在 Git Bash 里引号会被吃掉，`cmd.exe` 又被 PowerShell 工具的安全策略拦下。

### 4.3 改 + 验证（subagent 在 worktree 里做）——**先验证，后提交**

**验证是提交的前置条件，不是后置动作**：这一节全部通过之前，不许 commit、更不许合并到 main。
别图省事「先提交 / 先合并，回头再验证」——那样一旦发现问题，main 已经被污染，只能再开一轮修。

- 改代码，遵守 AGENTS.md 全部约定（跨平台、注释写「为什么」、只改被要求的地方、配色/设置项/命令的联动处）。
- 前端：`pnpm build`（Vite dev 不做类型检查）。
- 后端：`CARGO_TARGET_DIR="D:/CodeProjects/code-dock/src-tauri/target" cargo test --lib`（+ `cargo clippy`）——
  **复用主仓库 target**，只重编本 crate（约 30s），不必整轮 cargo 重编。
- **界面改动必须实测**（`/cdp-verify` / `scripts/cdp-check.cjs`），别只看代码、只跑类型检查就算过。
  要实测得有跑着**这一版代码**的实例：
  - 先探 5273 / 9222 / dev 进程有没有被占——**有别的会话或用户开着的 dev 实例，就不要抢、不要杀**；
    实在没有可用实例，才在这个 worktree 里起一个
    （`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222" nohup bash scripts/dev-local.sh ...`）。
  - 复用了别人的实例时，只做只读/临时动作，**验完把改过的界面状态还原**（清过滤框、收起刚展开的面板…）。
  - 自己起的实例，验完立刻停掉、让出端口，再进下一组。
- 验证不过就回改，别带着问题进第 5 节。

## 5. 阶段 D：提交 + 合并 + 推送 main

### 5.1 commit（在 worktree 内）

**前置条件**：本组已通过 4.3 的全部验证（含界面实测）。没验证过就不许提交。

按 `/git-commit` 的规矩：**按变更主体归类**，一条 issue 内也可能拆成多条，别一把 `git add -A`；
中文 Conventional Commits，正文写「为什么」；提交信息带上 issue 编号。

```bash
git add <该类别的文件> && git commit -m "$(cat <<'EOF'
fix(scope): 中文标题

为什么这么改（可选）。(#IKINTK)
EOF
)"
```

### 5.2 合并回 main + push main（**特性分支不推远程**）

**特性分支只留本地**，别 `git push` 它——本流程的特性分支是临时的，合并完就连同分支一起在本地删掉
（第 7 节），推到远程只会留下一堆已合并的孤儿分支。**远程只动 `main`。**

```bash
cd D:/CodeProjects/code-dock            # 回主仓库
git checkout main && git pull --ff-only
git merge --no-ff <fix|feat>/<topic> -m "Merge <fix|feat>/<topic>: 描述 (#IK...)"
git push origin main
```

- 合并提交照仓库既有风格 `Merge feat/<topic>: 描述 (#issue)`；一条 issue 一个合并提交，
  多 issue 共用一个分支时在括号里列全 `(#A #B)`。
- 前端没跑过 `pnpm build`、后端没跑过 `cargo test --lib` 就先补，别提交未验证的改动。
- **绝不 force push**：`git pull` 分叉了就停下如实报告，让用户决定 merge / rebase，别硬来。

### 5.3 冲突 / 失败

停下、原样贴错。**不要** `-X ours/theirs` 糊过去，也不要 `--no-verify` 跳过钩子。

## 6. 阶段 E：评论 + 关闭

**顺序固定：合并 → 评论 → 关闭**（issue 一旦关闭，Gitee 会禁用评论，事后补不了）。

先找关联 commit：

```bash
git log --oneline --grep="#<number>"
```

评论正文：一两句完成情况（改了什么、验证结果）+ 对应 commit 的**短 hash + 标题**；
确实没有关联 commit（纯文档 / 配置改动等）就跳过 commit 部分，别硬编一个。

```bash
gitee issue comment <number> -b "<评论正文>"
gitee issue close <number>
```

- **评论失败就停**，原样贴错——绝不跳过评论直接关 issue。
- 关闭失败时**重点说明「评论已发、issue 仍是 open」**，别让用户误以为关好了。
- 只做评论 + 关闭：不改标题、不删 issue。
- 全部走完汇总成表：编号 / 标题 / 分支 / commit / 结果。

## 7. 清理 worktree（收尾必做）

**陷阱**：`git worktree remove --force` 会递归删目录，**若 node_modules 联结还在，它会顺着联结把
主仓库的 node_modules 清空**。

正确顺序——先非递归摘掉联结，确认主仓库依赖还在，再删 worktree：

```powershell
[System.IO.Directory]::Delete("D:\CodeProjects\code-dock\.codebuddy\worktrees\<topic>\node_modules", $false)
Test-Path "D:\CodeProjects\code-dock\node_modules\.bin"     # 必须仍然是 True，否则停手
```

```bash
git worktree remove --force .codebuddy/worktrees/<topic>
git worktree prune
git branch -d <fix|feat>/<topic>            # 已合并，可安全删
```

分支没推过远程（见 5.2），删本地即可，不用去动远端。

## 8. 红线

- 授权的范围**只有本流程创建的 `feat/*` `fix/*` 分支与其对应 issue**；其它分支、其它 issue 一律不动。
- 永不 `--force` / `--force-with-lease` / `--no-verify` / 改 git config / 推 tag / `git push --all` / 开 PR。
- **特性分支不推远程**：`fix/*` `feat/*` 只留本地，合并进 main 后本地删除；远程只动 `main`。
- **安装版 CodeDock 一律不碰**：它 identifier 是 `com.codedock`、dev 是 `com.codedock.dev`，本就并存；
  唯一不能动的是用户正在用的安装版。
- 验证时 `localStorage` 是用户真实状态（主题、工作区列表、别名…），改完要还原。
- 只改被要求的地方，不顺手重排 import、不改命名、不清理「看起来没用」的代码。

## 9. 排障

| 症状 | 原因 / 处理 |
|---|---|
| `gitee` 报未登录 / 缺 scope | `gitee auth token` 确认；评论需 `notes` scope，缺了会回 401 |
| 已关闭 issue 评论报 401 | Gitee 关闭后禁用评论（body 是「当前issue已关闭评论功能」但 CLI 误报成 401）。别据此判 token 失效，改用「reopen → comment → close」 |
| `git worktree add` 报分支已存在 | 换个 `<topic>`，或先确认那个分支是不是上一轮的遗留（`git branch -a`） |
| worktree 里 `pnpm build` 报找不到依赖 | 4.2 的 node_modules 联结没建或建错目标 |
| cargo 报 `拒绝访问 (os error 5)` | 有残留 `codedock.exe` 占着 target；`taskkill //IM codedock.exe //F` 后重试（安装版别杀） |
| 合并后 `git push` 被拒 | 远端分叉了。停下报告，让用户决定，**绝不 force** |
| 删 worktree 后 `node_modules` 空了 | 违反了第 7 节顺序——联结没先摘。用 `pnpm install` 恢复主仓库依赖 |
