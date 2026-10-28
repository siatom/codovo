import { invoke } from "@tauri-apps/api/core";
import { pathKey } from "./fs";
import type { GitStatusPayload, WorkstreamInfo } from "./types";

/** 工作区根所属仓库的全部工作线（所有工作树 + 最近的本地分支）。 */
export function workstreamList(root: string): Promise<WorkstreamInfo[]> {
  return invoke<WorkstreamInfo[]>("workstream_list", { root });
}

/** 把一条工作线合并进当前主检出的基准分支。要求主工作区干净。 */
export function workstreamMerge(
  root: string,
  branch: string,
  base?: string | null,
): Promise<GitStatusPayload> {
  return invoke<GitStatusPayload>("workstream_merge", {
    root,
    branch,
    base: base ?? null,
  });
}

/** 移除一个干净 / 已合并的工作树；分支保留。 */
export function workstreamRemove(root: string, path: string): Promise<WorkstreamInfo[]> {
  return invoke<WorkstreamInfo[]>("workstream_remove", { root, path });
}

/** 新建工作树 + 分支。目录建在仓库同级的 `<repo>-worktrees/<name>` 下。 */
export function workstreamCreate(
  root: string,
  name: string,
  base?: string | null,
): Promise<WorkstreamInfo[]> {
  return invoke<WorkstreamInfo[]>("workstream_create", {
    root,
    name,
    base: base ?? null,
  });
}

// ---- 稍后处理 ----
//
// 「稍后」只影响总览里的注意力队列，不改变工作树本身。按仓库 + 分支记，
// 默认 24 小时；期间仍会出现在工作树列表里，只是不再占用「需要你」。

const SNOOZE_KEY = "codovo.workstreamSnooze";

function snoozeMap(): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(SNOOZE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "number") out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function snoozeKey(root: string, branch: string): string {
  return `${pathKey(root)}\u0000${branch}`;
}

export function isWorkstreamSnoozed(root: string, branch: string): boolean {
  const until = snoozeMap()[snoozeKey(root, branch)];
  return typeof until === "number" && until > Date.now();
}

export function snoozeWorkstream(root: string, branch: string, hours = 24) {
  try {
    const map = snoozeMap();
    map[snoozeKey(root, branch)] = Date.now() + hours * 3600_000;
    window.localStorage.setItem(SNOOZE_KEY, JSON.stringify(map));
  } catch {
    // 存不下就本次会话继续显示
  }
}
