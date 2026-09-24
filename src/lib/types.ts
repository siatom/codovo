export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export interface FileContent {
  text: string;
  isBinary: boolean;
  tooLarge: boolean;
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
}

export interface GitStatusPayload {
  isRepo: boolean;
  branch: string | null;
  /** HEAD 的提交号；空仓库（还没提交过）时是 null */
  head: string | null;
  ahead: number;
  behind: number;
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

/** 提交历史里的一条 */
export interface GitCommit {
  hash: string;
  short: string;
  author: string;
  /** Unix 秒 */
  time: number;
  subject: string;
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

/** 搜索的三个开关，和 VS Code 搜索框右边那排一致 */
export interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
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
