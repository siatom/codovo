import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { FileContent, FileEntry, GitStatusPayload } from "./types";

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

export function readFile(path: string): Promise<FileContent> {
  return invoke<FileContent>("fs_read_file", { path });
}

export function writeFile(path: string, text: string): Promise<void> {
  return invoke("fs_write_file", { path, text });
}

/** 当前工作区的 git 状态；目录不是仓库时 isRepo 为 false */
export function gitStatus(): Promise<GitStatusPayload> {
  return invoke<GitStatusPayload>("git_status");
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
