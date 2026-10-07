export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  /** 最近修改时间（Unix 毫秒），0 表示读不到 */
  modified: number;
}

export interface FileContent {
  text: string;
  isBinary: boolean;
  tooLarge: boolean;
  /**
   * 后端检测到的编码标签（如 `gbk`）。保存时原样回传给 `writeFile`，
   * 才能按原编码写回；二进制 / 超限时为空串。
   */
  encoding: string;
}

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
   * 这条是不是一个目录。只有未跟踪目录会整条折叠成一项（`? dir/`），
   * 前端据此不把它当文件读——点开差异 / 解读都会变成读目录而报错。
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
  /** 仓库正卡在一次没结束的合并里（有冲突待解决，或已解决待提交） */
  merging: boolean;
  /** 未合并（冲突）条目数，含 AA/DD 这种 XY 里没有 U 的 */
  conflicts: number;
  /** 改动条目总数；条目过多时可能大于 files.length */
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

/** 提交历史里的一条 */
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

// ---- 智能体（后端起一个 opencode 服务，见 src-tauri/src/agent.rs）----

/** agent_start 的返回；同一工作区重复调用会复用已有实例 */
export interface AgentInfo {
  port: number;
  /** opencode 报的版本号，裸 semver（v1 是 1.18.32、v2 是 2.0.16） */
  version: string;
  /** 启动时探测出来的接口代次："v1" / "v2"。界面显示用，排查时也用得上 */
  protocol: string;
  /**
   * 这个实例的工作目录。opencode 的会话全局存、混着各目录的记录，列历史时要拿它
   * 按 directory 过滤（数据库 Agent 的 cwd 前端算不出来，只能后端带出来）
   */
  cwd: string;
}

export interface AgentStatus {
  running: boolean;
  port: number | null;
}

/** 工具调用的四种状态，对应 opencode 里 ToolPart.state.status */
export type AgentToolStatus = "pending" | "running" | "completed" | "error";

export interface AgentToolState {
  status: AgentToolStatus;
  /** 工具入参，形状随工具而变（读文件是 filePath、bash 是 command） */
  input?: unknown;
  output?: string;
  /** opencode 给的一句话摘要，通常比 input 更适合当标题 */
  title?: string;
  error?: string;
}

/**
 * opencode 的 Part。只认渲染用得到的字段，其余类型原样兜在 raw 里——
 * 它的 part 种类还在增加，写死结构一升级就崩。
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
 * SSE 事件。opencode v2 的信封长这样：
 * `{id, created, type, location?, data?, durable?}` —— 事件类型在 `type`，
 * 载荷在 `data`。`properties` 是 v2 之前的旧壳，留着是为了容错（少一层字段
 * 就整个解析失败更糟）。
 */
export interface AgentEvent {
  type: string;
  properties?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

/** 一整轮对话的状态，由 lib/agent.ts 的 reducer 维护 */
export interface AgentConversation {
  /** 消息 id，按出现顺序 */
  order: string[];
  byId: Record<string, AgentMessage>;
  /** 这一轮还在跑（收到 session.idle 才算完） */
  streaming: boolean;
  error: string | null;
}

/** opencode 的会话摘要，GET /session 里的一条 */
export interface AgentSessionSummary {
  id: string;
  title: string;
  /** 最后活动时间，Unix 毫秒（opencode 的 time.updated） */
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
