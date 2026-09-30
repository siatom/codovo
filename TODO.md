# 待办

右栏「变更」面板的剩余工作。功能定位见 [README.md](./README.md)，模块约定见
[AGENTS.md](./AGENTS.md)。

状态截至 2026-09-30。

## 进度总览

原本列了 15 项优化，按成本分档推进：

| 批次 | 内容 | 状态 |
| --- | --- | --- |
| 1-5 | 前端低成本项（快捷键文案、右键菜单、行内打开文件、历史相对时间、未推送标记） | 已完成，见 `36535ae` |
| 6-10 | 前端项（路径筛选、提交按钮禁用原因、多条提交同展、滚动加载、分组独立折叠） | 已完成，见 `36535ae` |
| 11-15 | 后端项（行数统计、修正/撤销提交、分支切换、hunk 级暂存、stash） | 除 **14** 外已完成（**尚未提交**） |

## 未完成

### 14. hunk 级（代码块级）暂存与放弃

现在只能整文件暂存 / 取消暂存 / 放弃。这一项是唯一还没动的。

**体量判断：属于独立大功能，不是小改动**——跨「Rust 生成 patch」+「新命令」+「新 UI」
三块，单独排一批做。

**已勘察清楚的技术前提：**

- 现有 `run_git_raw`（`git.rs:207`）的 stdin 是 `Stdio::null()`，**喂不进 patch**。
  要么先把 patch 写成临时文件再 `git apply <tmp>`（改动小），要么改造 stdin（代价大）。
  倾向临时文件。
- 生成 patch 走 `git diff -U3 -- <path>`（`run_git_literal` 已有），加 `--recount`
  让 git 自己数 `@@` 计数，省掉一大类手算错误。
- 三种方向的操作：暂存 `git apply --cached`、取消暂存 `git apply --cached --reverse`、
  放弃工作区改动（用 unstaged diff）`git apply --reverse`。
- **注意和「两侧按 LF 比较」的关系**：`file_diff` 那条链上的 `normalize_newlines`
  （`git.rs:944`）是为了让差异比对不被 CRLF 干扰；但 patch 本身要交给 `git apply`，
  **不能先归一化**，否则生成出来的补丁和工作区字节不一致会 apply 失败。工作区是 CRLF
  时可能还需要 `--ignore-whitespace`。
- `\ No newline at end of file` 必须原样保留。
- 排除这些情形，回退到整文件操作：二进制（`fs_api::looks_binary`）、纯新增
  （`Side::Missing`，HEAD/index 里没这个路径）、纯删除（工作区里没有）。

**UI 方案（推荐第二个）：**

- (a) 在 Monaco 的 DiffEditor 上叠加行内按钮——**最贵**，要靠 decoration / view zone
  自己映射 hunk 与行号，且全仓库没有任何先例可抄。`EditorPane.tsx` 的差异编辑器是
  懒创建、只读的（`createDiffEditor`，见 `diffModelsRef`），加交互要动它的创建参数。
- (b) **在「变更」面板里原地展开 diff、每个 hunk 一行操作按钮**。最贴仓库「小改动、
  别上重方案」的取向，也不用碰 Monaco。
- (c) 只做「整块暂存 / 整块放弃」的简化版。

**MVP 建议：** 方案 (b) + 只覆盖「未暂存文件的暂存 / 放弃选中 hunk」。
砍掉：编辑器内行内按钮、暂存侧（staged）的 hunk 操作、二进制、新增 / 删除文件。

**粗量级：** `git.rs` 约 +200 行（hunk 解析 + apply 命令）、`lib.rs` 注册 1 处、
`fs.ts` 约 +20、新增 hunk 列表组件约 150、`GitChangesPane.tsx` 接入约 60。

## 已明确不做（除非单独立项）

这几项都超出了「小改动」的量级，和分析时一样先搁置：

- 冲突的三路合并编辑器，以及冲突行的「采用当前 / 采用传入」
- 提交图谱（graph）
- blame 与文件历史

## 遗留小问题（可选，不阻塞）

- **numstat 让每次轮询多起 2 个 git 进程**：`status_of` 里为拿增删行数跑了
  `git diff --numstat` 与 `--cached --numstat`。`git_status` 是 2 秒轮询，改动多、
  仓库大时是笔额外开销。真嫌重可以缓一轮（隔次统计）或只在改动列表可见时带行数。
- **非 UTF-8 路径的行数会静默丢**：`counts_by_path` 用 lossy 转换后的字符串比对，
  极端文件名（非 UTF-8 字节）匹配不上就没有行数。属病态输入，暂不处理。
- **`--amend --no-edit` 在暂存区为空时是 no-op**（exit 0、提交号不变）：界面上会提示
  成功但历史没变。不误导，但可以考虑这种情形直接提示「没有要修正的内容」。
- **两条 `role="separator"` 拖动条只有指针操作**，没有方向键调节。

## 验证方式

- `pnpm build`（Vite dev 不做类型检查）
- `cd src-tauri && cargo test --lib`、`cargo clippy --all-targets`
- **界面验证**：macOS 上 `scripts/cdp-check.cjs` 用不了（那是 WebView2 专属，
  WKWebView 没有 CDP）。改用一次性脚本：无头 Chrome + 假的
  `window.__TAURI_INTERNALS__` 桥，页面指向 `dist/`，用 DOM 断言（本机看不了截图）。
  起静态服务 / 起 Chrome / 驱动 / 断言必须塞进同一次调用，收尾记得
  `pkill -f "codedock-cdp-"`。
