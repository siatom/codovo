# 待办

右栏「变更」面板的剩余工作。功能定位见 [README.md](./README.md)，模块约定见
[AGENTS.md](./AGENTS.md)。

**状态：全部完成（截至 2026-10-08）。** 本文件不再有待办项，保留作为这段工作的记录。

## 进度总览

原本列了 15 项优化，按成本分档推进：

| 批次 | 内容 | 状态 |
| --- | --- | --- |
| 1-5 | 前端低成本项（快捷键文案、右键菜单、行内打开文件、历史相对时间、未推送标记） | 已完成，见 `36535ae` |
| 6-10 | 前端项（路径筛选、提交按钮禁用原因、多条提交同展、滚动加载、分组独立折叠） | 已完成，见 `36535ae` |
| 11-15 | 后端项（行数统计、修正/撤销提交、分支切换、hunk 级暂存、stash） | 全部已完成 |

11-15 里 11 见 `0991bc9`、12 见 `1bd9c83`+`cb7888f`+`7044569`、13 见 `fb90cd1`、
14 见 `3ceba88`、15 见 `dcbaf00`。

## 已完成：14. hunk 级（代码块级）暂存与放弃

15 项里最后一项，按勘察时定的 MVP 落地：**方案 (b)，只覆盖未暂存侧的暂存 / 放弃**。

- 后端 `git.rs`：`split_patch` 按 `@@` 切「文件级头 + 各 hunk」；`file_hunks` 取
  `git diff --no-color -U3` 的原始输出；`apply_patch` 把补丁写临时文件后
  `git apply --recount [--cached|--reverse]`；命令 `git_file_hunks` / `git_apply_patch`。
- 前端：`GitChangesPane` 未暂存分组每行多个展开箭头，展开后逐块列出 `@@` 头 + 正文 +
  「暂存 / 放弃」；放弃走确认框。新增 `PatchHunk` / `FileHunks` / `HunkAction` 类型。
- 回退整文件操作的情形：二进制、纯新增（`?`）、纯删除（`D`）、冲突（`U`）。
  判据在 `GitChangesPane.tsx` 的 `canHunk`。

**和勘察笔记的出入（记下来免得下次又踩）：**

- `--recount` 是 **`git apply`** 的选项，`git diff` 根本不认（会 `invalid option` 直接
  非 0 退出，被 `run_git_literal` 吞成空输出、一个 hunk 都没有）。放在 apply 侧才对。
- 「工作区是 CRLF 时可能需要 `--ignore-whitespace`」**不需要**：补丁由 `git diff` 生成、
  再由 `git apply` 落回去，行尾转换是自洽的。前提是**别**在这条链上过
  `normalize_newlines`——已由单测 `hunks_round_trip_with_a_crlf_worktree` 钉住。
- 勘察时说的「不改 stdin、走临时文件」是对的，照做了。

## 已明确不做（除非单独立项）

这几项都超出了「小改动」的量级，和分析时一样先搁置：

- 冲突的三路合并编辑器，以及冲突行的「采用当前 / 采用传入」
- 提交图谱（graph）
- blame 与文件历史

## 遗留小问题（已全部处理，2026-10-08）

- **numstat 让每次轮询多起 2 个 git 进程**：已修（`c832e49`）。`git_status` 增加
  `with_counts` 参数（缺省 true），前端 `useGitStatus` 只在「变更」面板可见时传 true——
  面板收着、或看别的模块时跳过那两次 numstat。写命令照旧带回行数，不受影响。
- **非 UTF-8 路径的行数会静默丢**：经单测实证**并非缺陷**（`c832e49`）。`parse_status`
  与 `counts_by_path` 两侧都走 `String::from_utf8_lossy`，同一串字节换出同一个替换串，
  计数能对上；补了回归测试 `numstat_counts_match_non_utf8_paths` 钉住这个结论。
- **`--amend --no-edit` 在暂存区为空时是 no-op**：已修（`c832e49`）。空暂存区 + 不给信息
  时 `amend_commit` 直接返回「没有要修正的内容」，界面不再误报成功；给了 `-m` 仍允许
  （那是纯改提交信息，有意义）。
- **两条 `role="separator"` 拖动条只有指针操作**：已修（`2e001fe`）。两条拖动条都补了
  `tabIndex` + 方向键（`ArrowUp` / `ArrowDown`，步长 16px，上下限与拖动路径一致）、
  `aria-valuenow/min/max` 与键盘焦点样式。

## 验证方式

- `pnpm build`（Vite dev 不做类型检查）
- `cd src-tauri && cargo test --lib`、`cargo clippy --all-targets`
- **界面验证**：macOS 上 `scripts/cdp-check.cjs` 用不了（那是 WebView2 专属，
  WKWebView 没有 CDP）。改用一次性脚本：无头 Chrome + 假的
  `window.__TAURI_INTERNALS__` 桥，页面指向 `dist/`，用 DOM 断言（本机看不了截图）。
  起静态服务 / 起 Chrome / 驱动 / 断言必须塞进同一次调用，收尾记得
  `pkill -f "codedock-cdp-"`。
