import { invoke } from "@tauri-apps/api/core";
import { pathKey } from "./fs";
import type {
  FileHunks,
  GitStatusPayload,
  WorkstreamInfo,
  WorkstreamReview,
} from "./types";

/**
 * 变更中心里「打开审阅」需要的上下文。
 *
 * root 永远是**仓库主检出**（工作区活动根），不随工作树变化；path 为空表示
 * 这是一条没被检出的分支。审阅里的所有 git 命令都以 root + path 为边界，
 * 不会切换编辑器 / 终端所在的上下文。
 */
export interface ReviewTarget {
  root: string;
  path: string | null;
  branch: string;
  base: string;
  baseSha: string | null;
  head: string | null;
  name: string;
  kind: WorkstreamInfo["kind"];
}

/** 工作区根所属仓库的全部工作线（worktree + 有独有提交的未检出分支）。 */
export function workstreamList(root: string): Promise<WorkstreamInfo[]> {
  return invoke<WorkstreamInfo[]>("workstream_list", { root });
}

/** 一条工作线的审阅数据：基准、提交、已提交文件、未提交文件。 */
export function workstreamReview(
  root: string,
  path: string | null,
  branch: string,
  base: string,
): Promise<WorkstreamReview> {
  return invoke<WorkstreamReview>("workstream_review", {
    root,
    path: path ?? null,
    branch: branch || null,
    base: base || null,
  });
}

/**
 * 已提交文件在审阅工作台里的逐块 diff。
 *
 * `relative` 是仓库根相对路径；`from` / `to` 是完整提交号。后端只接受十六进制，
 * 不会把任意 revspec 放进命令。
 */
export function workstreamFileHunks(
  root: string,
  path: string | null,
  relative: string,
  from: string,
  to: string,
): Promise<FileHunks> {
  return invoke<FileHunks>("workstream_file_hunks", {
    root,
    path: path ?? null,
    relative,
    from,
    to,
  });
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
    // 存不下就本次会话继续显示，不影响审阅
  }
}

// ---- 审阅状态 ----
//
// 只存本地 WebView 的 localStorage：审阅进度是个人状态，不该写进仓库、也不该
// 跟着分支到处走。键里带「仓库 + 分支 + 文件」，提交号变化即自动失效。

const REVIEW_KEY = "codovo.workstreamReviewed";

type ReviewStore = Record<string, string>;

function reviewKey(root: string, branch: string, file: string): string {
  return `${pathKey(root)}\u0000${branch}\u0000${file}`;
}

function readReviewStore(): ReviewStore {
  try {
    const raw = window.localStorage.getItem(REVIEW_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: ReviewStore = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function writeReviewStore(store: ReviewStore) {
  try {
    window.localStorage.setItem(REVIEW_KEY, JSON.stringify(store));
  } catch {
    // 存不下就退化成「本次会话有效」，不影响审阅
  }
}

/** 这个文件是否已经按 `revision` 审过。revision 变了就自动回到未审。 */
export function isReviewed(
  root: string,
  branch: string,
  file: string,
  revision: string,
): boolean {
  return readReviewStore()[reviewKey(root, branch, file)] === revision;
}

/** 标记 / 取消标记一个文件已审。传 null 表示取消。 */
export function setReviewed(
  root: string,
  branch: string,
  file: string,
  revision: string | null,
) {
  const store = readReviewStore();
  const key = reviewKey(root, branch, file);
  if (revision) store[key] = revision;
  else delete store[key];
  writeReviewStore(store);
}

/** 一条工作线审过几个文件（按当前 revision 过滤）。 */
export function countReviewed(
  root: string,
  branch: string,
  files: { relative: string; revision: string }[],
): number {
  const store = readReviewStore();
  return files.filter(
    (file) => store[reviewKey(root, branch, file.relative)] === file.revision,
  ).length;
}
