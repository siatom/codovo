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
