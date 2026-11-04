export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  /**
   * 文件大小（字节）。目录没有意义，固定 0；
   * 文件名搜索拼出来的条目拿不到 stat，缺这个字段（悬停时不显示大小）
   */
  size?: number;
  /** 最近修改时间（Unix 毫秒），0 表示读不到 */
  modified: number;
}

export interface FileContent {
  text: string;
  isBinary: boolean;
  /**
   * 兼容旧前端：新逻辑不再因为「文件大」置位，只有真正读不了的情况才用。
   * 大文件看 `isLarge` / `truncated`。
   */
  tooLarge: boolean;
  /**
   * 后端检测到的编码标签（如 `gbk`）。保存时原样回传给 `writeFile`，
   * 才能按原编码写回；二进制 / 读不了时为空串。
   */
  encoding: string;
  /** 文件实际大小（字节）。截断时是完整大小，不是读进来的那一段 */
  size: number;
  /** 只读文件，或内容已截断（截断后保存会把文件毁成半截，必须禁写） */
  readOnly: boolean;
  /** 文件超过 64MB，`text` 只是前 8MB */
  truncated: boolean;
  /** 文件超过 8MB，前端据此关掉语法解析 / Markdown 预览 */
  isLarge: boolean;
  /** 原文件的换行风格：`LF` / `CRLF` / `CR` */
  eol: Eol;
  /** 原文件开头是否带 BOM，保存时原样回传给 `writeFile` */
  hasBom: boolean;
}

/** 文档翻译目标语言；设置里的 translateTarget 与翻译视图共用 */
export type TranslateTarget = "zh" | "en";

/** 文件换行风格，和后端 `eol` 字段一一对应 */
export type Eol = "LF" | "CRLF" | "CR";

/** 图片预览的内容：`data` 是能直接喂给 `<img src>` 的 data URL，超限时为空串 */
export interface ImageContent {
  data: string;
  tooLarge: boolean;
}

/**
 * 编辑器里选中的一段位置，浮窗把它送去终端 / 智能体输入框。
 * path 是工作区内的相对路径，行号 1 起算；只选了一行时 start === end。
 */
export interface EditorLocation {
  path: string;
  start: number;
  end: number;
}

export type PtyEvent =
  | { type: "data"; data: string }
  | { type: "exit"; code: number };

export interface GitFileStatus {
  /** 绝对路径（原生分隔符），打开文件用 */
  path: string;
  /** 工作区相对路径（正斜杠），改动列表显示用 */
  relative: string;
  /** porcelain v2 的 XY：X 是暂存区状态，Y 是工作区状态 */
  index: string;
  worktree: string;
  /**
   * 这条是不是一个目录。正常为 false——后端用 `--untracked-files=all` 逐个列出未跟踪
   * 文件、不折叠目录；只有 `normal` 折叠形态（`? dir/`）才会是目录。前端据此不把它
   * 当文件读——点开差异 / 解读都会变成读目录而报错。
   */
  isDir: boolean;
  /**
   * 两侧各增删了几行。`null` = 该侧没有改动，或者统计不出来（二进制、未跟踪文件）。
   * 同一个文件在暂存 / 未暂存两个分组里显示的是各自那一侧的数字。
   */
  stagedAdded: number | null;
  stagedRemoved: number | null;
  unstagedAdded: number | null;
  unstagedRemoved: number | null;
}

/** 分支下拉里的一条本地分支 */
export interface GitBranch {
  name: string;
  /** 上游短名，如 origin/main；没配上游时是 null */
  upstream: string | null;
  ahead: number;
  behind: number;
  /** 上游被删了（`[gone]`），这时 ahead/behind 没有意义 */
  gone: boolean;
  current: boolean;
  /**
   * 被**另一个** worktree 检出的那个工作树路径；没被别的 worktree 占用时是 null。
   * git 不允许同一分支被两个 worktree 同时检出，切过去必然报错，界面据此提前拦下。
   */
  worktree: string | null;
}

/** 一个 git 标签 */
export interface TagInfo {
  /** 短名，已去掉 refs/tags/ 前缀 */
  name: string;
  /** 附注标签为 true，轻量标签为 false */
  annotated: boolean;
  /** 指向的提交短号 */
  target: string;
  /** 附注标签的说明；轻量标签为空串 */
  message: string;
}

/**
 * 一个 git worktree。
 *
 * `path` 拿它当 root 调别的 git 命令：目录存在时后端已经登记过白名单（canonical
 * 路径），不存在（prunable）时不能当 root 用。
 */
export interface WorktreeInfo {
  path: string;
  /** 目录名，下拉项的主标题 */
  name: string;
  /** 检出的分支短名；游离 HEAD 或 bare 时为 null */
  branch: string | null;
  /** 游离 HEAD（没检出任何分支） */
  detached: boolean;
  /** bare 仓库的主工作树 */
  bare: boolean;
  locked: boolean;
  lockReason: string | null;
  /** 目录已经不在、可以被 prune */
  prunable: boolean;
  pruneReason: string | null;
  /** 目录此刻是否真实存在（prunable 的是 false） */
  exists: boolean;
  /** 是不是当前面板所在的那个工作树 */
  current: boolean;
}

/**
 * 一个 worktree 的轻量动态状态（概览逐条标注用，`git_worktree_status` 返回）。
 *
 * 与 `WorktreeInfo` 分开两份：那份是**结构**（有哪些工作树、检出了什么、是否失效），
 * 跟着 `git_worktree_list` 走；这份是**动态**（脏不脏、领先落后、进行中），成本高、
 * 拉得慢，按 path 对齐。分开之后概览的轮询节奏不用迁就结构列表。
 */
export interface WorktreeStatus {
  /** 工作树目录的绝对路径；和 `WorktreeInfo.path` 同一写法，按它对齐 */
  path: string;
  /** 检出的分支短名；游离 HEAD 时为 null */
  branch: string | null;
  /** HEAD 的提交号；空仓库时为 null */
  head: string | null;
  /** 未提交的文件数（未跟踪目录已按文件展开计） */
  changed: number;
  /** 未合并（冲突）条目数 */
  conflicts: number;
  /** 卡在一次没结束的多步操作里（合并 / 变基 / 拣选 / 还原） */
  merging: boolean;
  /** 进行中的具体操作类型；没有时是 null */
  mergeKind: "merge" | "rebase" | "cherryPick" | "revert" | null;
  ahead: number;
  behind: number;
}

/**
 * 变更中心里的一条「工作线」：一个 worktree，或一条没被检出的本地分支。
 *
 * 和 `WorktreeInfo` 的分工：那个只描述结构（有哪些工作树、检出了什么），
 * 这个把结构 + 相对基准分支的提交/脏改动/合并状态汇总到一起，是总览列表的数据源。
 */
export interface WorkstreamInfo {
  /** 工作树绝对路径；分支条目为空串 */
  path: string;
  /** 显示名：工作树用目录名，分支用分支名 */
  name: string;
  /** main = 工作区根所在检出；worktree = 其他工作树；branch = 本地分支 */
  kind: "main" | "worktree" | "branch";
  branch: string | null;
  /** 对照的基准分支 */
  base: string | null;
  /** base 与 head 的 merge-base */
  baseSha: string | null;
  /** 基准分支当前的提交号；和 head 相同说明还没有独有提交 */
  baseHead: string | null;
  head: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  lockReason: string | null;
  prunable: boolean;
  pruneReason: string | null;
  exists: boolean;
  current: boolean;
  /** 未提交文件数 */
  changed: number;
  conflicts: number;
  merging: boolean;
  mergeKind: "merge" | "rebase" | "cherryPick" | "revert" | null;
  /** 相对 base 领先 / 落后 */
  ahead: number;
  behind: number;
  /** 相对上游分支的领先 / 落后（当前检出卡片用） */
  upstreamAhead: number;
  upstreamBehind: number;
  /** 最后一条提交的时间（Unix 秒），空仓库为 0 */
  lastCommitTime: number;
  lastCommitSubject: string;
  /** base...head（已提交部分）的改动规模 */
  diffFiles: number;
  additions: number;
  deletions: number;
  /** 分支已经完全合进 base */
  merged: boolean;
}

/**
 * 终端会话的归属：雷达要靠它判断「哪个工作树上有终端在跑、有没有在等用户」。
 *
 * 单独列一份而不是让雷达直接读 attention store：那边按工作区根记，落不到具体
 * 工作树上；这里由 TerminalPane 把会话的 cwd 一并带出来。
 */
export interface TerminalSessionInfo {
  id: number;
  /** 会话 shell 的落点：工作区根，或某个工作树路径 */
  cwd: string;
  /** 停在交互提示 / 一轮任务跑完等下一步；null = 没在等 */
  attention: "permission" | "question" | "prompt" | "done" | null;
}

/** 一条 stash 记录 */
export interface GitStash {
  /** `stash@{n}` 里的那个 n，恢复 / 丢弃时要原样带回去 */
  index: number;
  message: string;
  hash: string;
  /** 创建时间，Unix 秒 */
  time: number;
}

export interface GitStatusPayload {
  isRepo: boolean;
  branch: string | null;
  /** HEAD 的提交号；空仓库（还没提交过）时是 null */
  head: string | null;
  ahead: number;
  behind: number;
  /** 仓库正卡在一次没结束的多步操作里（合并 / 变基 / 拣选 / 还原） */
  merging: boolean;
  /**
   * 进行中的具体操作类型；没有任何进行中的操作时是 null。
   * 只有 merge 能用「完成合并 / 中止合并」收尾，其余三种得回终端处理。
   */
  mergeKind: "merge" | "rebase" | "cherryPick" | "revert" | null;
  /** 未合并（冲突）条目数，含 AA/DD 这种 XY 里没有 U 的 */
  conflicts: number;
  /** 改动**文件**总数（未跟踪目录已展开成文件，不按目录计）；条目过多时可能大于 files.length */
  changed: number;
  files: GitFileStatus[];
}

export interface FileDiff {
  /** 基线侧（暂存看 HEAD、未暂存看 index）；该版本里没有这个路径时是空串 */
  original: string;
  /** 当前侧（暂存看 index、未暂存看工作区文件）；文件被删时是空串 */
  modified: string;
  isBinary: boolean;
  tooLarge: boolean;
}

/** 挂在某个提交上的引用，图形化历史里画成行内的标签 chip */
export interface CommitRef {
  /** 短名，已去掉 refs/heads、refs/remotes、refs/tags 前缀 */
  name: string;
  /** head = 当前分支（HEAD 指向）；branch / remote / tag */
  kind: "head" | "branch" | "remote" | "tag";
}

/** 时间线里的一条 */
export interface GitCommit {
  hash: string;
  short: string;
  author: string;
  /** Unix 秒 */
  time: number;
  subject: string;
  /** 主题之后的正文（原样，含换行）；没有正文时是空串 */
  body: string;
  /** 父提交的完整 hash（合并提交有多个）；根提交为空 */
  parents: string[];
  /** 这个提交上挂的引用 */
  refs: CommitRef[];
}

/** 一条提交的改动规模，悬停浮框上显示 */
export interface CommitStat {
  files: number;
  insertions: number;
  deletions: number;
}

/** 某个提交里改动的一个文件 */
export interface GitCommitFile {
  /** 绝对路径，点开差异用 */
  path: string;
  /** 工作区相对路径（正斜杠），显示用 */
  relative: string;
  /** A / M / D / R / C */
  status: string;
}

/** 一次 git clone 的进度事件（后端 `git-clone-progress`） */
export interface CloneProgress {
  /** 对应发起它的那次克隆，前端按它过滤 */
  id: string;
  /** 阶段名（Counting / Compressing / Receiving / Resolving…） */
  phase: string;
  /** 百分比；这一行解析不出来时是 null（前端显示不确定态） */
  percent: number | null;
  /** 原始那一行 */
  text: string;
}

/**
 * 「放弃修改」还原到哪一侧，和 DiffSource 同一个思路用标签枚举：
 * 调用处一眼能看出语义，不用去翻 bool 的含义。
 */
export type DiscardSource = { mode: "unstaged" } | { mode: "staged" };

/** 一个文件里的一段改动（统一 diff 里的一个 `@@` 块） */
export interface PatchHunk {
  /** `@@ -12,6 +12,7 @@ fn foo()` 整行，显示用 */
  header: string;
  /** 这个 hunk 的原文（`@@` 行 + 内容行）。拼补丁时原样接在文件级头后面，一个字节都别改 */
  text: string;
  added: number;
  removed: number;
}

/** 一个未暂存文件的 hunk 列表；hunks 为空表示这个文件做不了逐块操作（二进制、新增 / 删除等） */
export interface FileHunks {
  /** 文件级头（`diff --git` 到第一个 `@@` 之前），拼补丁时要带上 */
  header: string;
  hunks: PatchHunk[];
}

/** 一个 hunk 要往哪边落，和 DiscardSource 同一个思路 */
export type HunkAction = { mode: "stage" } | { mode: "unstage" } | { mode: "discard" };

/** 搜索的三个开关，和 VS Code 搜索框右边那排一致；后两个是文件 glob 过滤 */
export interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  /** 只搜这些 glob（逗号分隔）；空串表示不限 */
  include: string;
  /** 跳过这些 glob（逗号分隔）；空串表示不排除 */
  exclude: string;
}

export interface SearchMatch {
  /** 1 起算 */
  line: number;
  /** 1 起算，UTF-16 单位 —— Monaco 的列就是这么算的，能直接喂给 Range */
  column: number;
  /** 匹配长度，UTF-16 单位 */
  length: number;
  /** 整行原文 */
  text: string;
}

export interface SearchFile {
  /** 绝对路径，打开文件用 */
  path: string;
  /** 工作区内的相对路径（正斜杠），显示用 */
  relative: string;
  matches: SearchMatch[];
}

export interface SearchResult {
  files: SearchFile[];
  /** 撞到上限被截断了 */
  truncated: boolean;
  /** 有多少个文件因为超过 2MB 被跳过 */
  skippedLarge: number;
}

export interface ReplacedFile {
  path: string;
  replaced: number;
}

export interface ReplaceFailure {
  path: string;
  message: string;
}

export interface ReplaceResult {
  files: ReplacedFile[];
  totalReplaced: number;
  /** 单个文件失败不影响其它文件，失败的都记在这里 */
  errors: ReplaceFailure[];
}

// ---- 智能体（后端进程内的 Rig 运行时，见 src-tauri/src/agent/）----

/** agent_start 的返回；同一工作区重复调用会复用已有实例 */
export interface AgentInfo {
  /** 生效的模型引用，形如 `provider/model` */
  model: string;
  /** 这个槽位的工作目录 */
  workspace: string;
}

export interface AgentStatus {
  /** 槽位是否已经建起来 */
  running: boolean;
  /** 是否有正在跑的一轮 */
  busy: boolean;
}

/** 工具调用的四种状态 */
export type AgentToolStatus = "pending" | "running" | "completed" | "error";

export interface AgentToolState {
  status: AgentToolStatus;
  /** 工具入参，形状随工具而变（读文件是 filePath、bash 是 command） */
  input?: unknown;
  output?: string;
  /** 工具自己给的一句话摘要，通常比 input 更适合当标题 */
  title?: string;
  error?: string;
}

/**
 * 一条消息里的片段。只认渲染用得到的几种，其余类型原样兜在 raw 里——
 * 后端将来多认一种内容类型时，老版本界面不至于整段崩掉。
 */
export type AgentPart =
  | { id: string; messageID: string; type: "text"; text: string }
  | { id: string; messageID: string; type: "reasoning"; text: string }
  | {
      id: string;
      messageID: string;
      type: "tool";
      callID: string;
      tool: string;
      state: AgentToolState;
    }
  // 认不出的 part 类型都归到这里。type 必须是字面量而不是 string，
  // 否则它会匹配上所有分支，判别联合就收窄不了了
  | { id: string; messageID: string; type: "unknown"; raw: unknown };

export interface AgentMessage {
  id: string;
  role: "user" | "assistant";
  parts: AgentPart[];
}

/**
 * 助手事件。形状由后端 `src-tauri/src/agent/mod.rs` 的 emit 调用定义，
 * 前端 `lib/agent.ts` 的 reducer 一一对应。
 */
export type AgentEvent =
  | { type: "runStarted"; sessionId: string; messageId: string; text?: string }
  | { type: "textDelta"; sessionId: string; messageId: string; delta: string }
  | { type: "reasoningDelta"; sessionId: string; messageId: string; delta: string }
  | {
      type: "toolCall";
      sessionId: string;
      messageId: string;
      callId: string;
      tool: string;
      input?: unknown;
    }
  | { type: "toolResult"; sessionId: string; callId: string; ok: boolean; output: string }
  | { type: "runFinished"; sessionId: string; messageId: string }
  | { type: "runFailed"; sessionId: string; messageId: string; message: string };

/** 一整轮对话的状态，由 lib/agent.ts 的 reducer 维护 */
export interface AgentConversation {
  /** 消息 id，按出现顺序 */
  order: string[];
  byId: Record<string, AgentMessage>;
  /** 这一轮还在跑（收到 runFinished / runFailed 才算完） */
  streaming: boolean;
  error: string | null;
}

/** 一条会话的摘要，`agent_list_sessions` 返回的一项 */
export interface AgentSessionSummary {
  id: string;
  title: string;
  /** 最后活动时间，Unix 毫秒 */
  updated: number;
}

/** 某个 CLI 写在磁盘上的会话记录，cli_list_sessions 返回的一条 */
export interface CliSessionInfo {
  /** 会话 id，resume 要用的就是它 */
  id: string;
  /** 抠不出标题时是空串，显示成「未命名会话」 */
  title: string;
  /** 记录文件的最后修改时间，Unix 毫秒 */
  updated: number;
  /** 记录里记的工作目录，仅供排查 */
  cwd: string;
}
