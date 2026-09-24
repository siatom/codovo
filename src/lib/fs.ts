import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { DiffSource } from "./tabs";
import type {
  FileContent,
  FileDiff,
  FileEntry,
  GitCommit,
  GitCommitFile,
  GitStatusPayload,
  ReplaceResult,
  SearchOptions,
  SearchResult,
} from "./types";

const WORKSPACE_KEY = "codedock.workspace";
const WORKSPACES_KEY = "codedock.workspaces";

/** 当前工作区；用户还没选目录时为 null */
export function getRoot(): Promise<string | null> {
  return invoke<string | null>("fs_root");
}

export function setRoot(path: string): Promise<string> {
  return invoke<string>("fs_set_root", { path });
}

/** 弹目录选择框并设为工作区；用户取消时返回 null */
export async function pickWorkspaceFolder(): Promise<string | null> {
  const picked = await open({ directory: true, multiple: false, title: "选择工作目录" });
  if (typeof picked !== "string") return null;
  return setRoot(picked);
}

export function readSavedWorkspace(): string | null {
  try {
    return window.localStorage.getItem(WORKSPACE_KEY);
  } catch {
    return null;
  }
}

export function saveWorkspace(path: string) {
  try {
    window.localStorage.setItem(WORKSPACE_KEY, path);
  } catch {
    // 隐私模式等场景写不进去，忽略即可，只是下次启动不会自动打开
  }
}

export function clearSavedWorkspace() {
  try {
    window.localStorage.removeItem(WORKSPACE_KEY);
  } catch {
    // 同上
  }
}

/** 用过的目录，最近打开的排在最前。 */
export function readSavedWorkspaces(): string[] {
  try {
    const raw = window.localStorage.getItem(WORKSPACES_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

export function saveWorkspaces(paths: string[]) {
  try {
    window.localStorage.setItem(WORKSPACES_KEY, JSON.stringify(paths));
  } catch {
    // 同 saveWorkspace
  }
}

export function listDir(path: string): Promise<FileEntry[]> {
  return invoke<FileEntry[]>("fs_list_dir", { path });
}

/**
 * 按文件名递归搜工作区（大小写不敏感的子串匹配），返回命中的绝对路径。
 * 后端会跳过 node_modules / .git / target 这类目录，并且有结果条数上限。
 */
export function searchFiles(query: string): Promise<string[]> {
  return invoke<string[]>("fs_search_files", { query });
}

/**
 * 按内容递归搜工作区，带大小写 / 全字 / 正则三个开关。结果按文件分组，
 * 行列都用 UTF-16 单位，能直接喂给 Monaco 的 Range。
 */
export function searchContents(
  query: string,
  options: SearchOptions,
): Promise<SearchResult> {
  return invoke<SearchResult>("fs_search_content", { query, options });
}

/** 替换单条匹配；行列对不上时后端会报「内容已经变了」，让用户重新搜索 */
export function replaceOne(request: {
  path: string;
  position: { line: number; column: number; length: number };
  query: string;
  options: SearchOptions;
  replacement: string;
}): Promise<void> {
  return invoke("fs_replace_one", request);
}

/** 替换一批文件里的所有匹配；只动传进来的这些路径 */
export function replaceAll(request: {
  paths: string[];
  query: string;
  options: SearchOptions;
  replacement: string;
}): Promise<ReplaceResult> {
  return invoke<ReplaceResult>("fs_replace_all", request);
}

export function readFile(path: string): Promise<FileContent> {
  return invoke<FileContent>("fs_read_file", { path });
}

export function writeFile(path: string, text: string): Promise<void> {
  return invoke("fs_write_file", { path, text });
}

export function createFile(path: string): Promise<void> {
  return invoke("fs_create_file", { path });
}

export function createDirectory(path: string): Promise<void> {
  return invoke("fs_create_directory", { path });
}

/**
 * 工作区里的目录结构变了（后端监听 + 防抖后才发）。载荷是需要重新列一遍的
 * 目录绝对路径，调用方自己决定哪些还没展开、不用管。
 */
export function onDirsChanged(handler: (dirs: string[]) => void): Promise<UnlistenFn> {
  return listen<string[]>("fs-changed", (event) => handler(event.payload));
}

/** 当前工作区的 git 状态；目录不是仓库时 isRepo 为 false */
export function gitStatus(): Promise<GitStatusPayload> {
  return invoke<GitStatusPayload>("git_status");
}

/** 暂存；不传 paths 表示全部暂存。返回写完之后的新状态。 */
export function gitStage(paths?: string[]): Promise<GitStatusPayload> {
  return invoke<GitStatusPayload>("git_stage", { paths: paths ?? null });
}

/** 取消暂存；不传 paths 表示全部取消。 */
export function gitUnstage(paths?: string[]): Promise<GitStatusPayload> {
  return invoke<GitStatusPayload>("git_unstage", { paths: paths ?? null });
}

export function gitCommit(message: string): Promise<GitStatusPayload> {
  return invoke<GitStatusPayload>("git_commit", { message });
}

/**
 * 一个改动文件的两侧内容。`source` 决定跟谁比：
 * 未暂存比 index、暂存比 HEAD、看某个提交比它的父提交。
 */
export function gitFileDiff(path: string, source: DiffSource): Promise<FileDiff> {
  return invoke<FileDiff>("git_file_diff", { path, source });
}

/** 提交历史，最新的在最前；不传 limit 就取一页 */
export function gitLog(limit?: number): Promise<GitCommit[]> {
  return invoke<GitCommit[]>("git_log", { limit: limit ?? null });
}

/** 某个提交改了哪些文件 */
export function gitCommitFiles(rev: string): Promise<GitCommitFile[]> {
  return invoke<GitCommitFile[]>("git_commit_files", { rev });
}

/** 后端一律用原生分隔符；界面按 VS Code 习惯显示 `/`。 */
export function toDisplayPath(path: string): string {
  return path.replace(/\\/g, "/");
}

/**
 * 路径的归一化 key，用来做 Map 的键和相等判断。
 * Windows 路径不区分大小写，分隔符也可能混用（对话框给 `/`、后端给 `\`、
 * git 给 `/`），不归一化就会把同一个文件认成两个。
 */
export function pathKey(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

/** 判断两个路径是不是同一个目录。 */
export function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}
