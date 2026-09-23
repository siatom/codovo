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
  /** 绝对路径（原生分隔符），和 FileEntry.path 同一套写法 */
  path: string;
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
