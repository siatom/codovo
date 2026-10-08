import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { gitStatus, pathKey, rootsKeyOf } from "./fs";
import type { GitStatusPayload } from "./types";

/** 轮询间隔。本地仓库的 status 通常几十毫秒，2 秒足够跟手又不至于吵 */
const POLL_MS = 2000;

export type GitMarkKind = "modified" | "added" | "untracked" | "deleted" | "conflict";

export interface GitMark {
  /** 行尾显示的单字母 */
  label: string;
  kind: GitMarkKind;
}

/** 一条改动。不做去重也不做合并，`MM` 这种两列都有内容的会原样保留。 */
export interface GitChange {
  /** 绝对路径，点击打开用 */
  path: string;
  /** 工作区相对路径（正斜杠），显示用 */
  relative: string;
  /** porcelain v2 的 X 列：暂存区状态 */
  index: string;
  /** porcelain v2 的 Y 列：工作区状态 */
  worktree: string;
  /** 这条是不是一个目录（只有未跟踪目录会整条折叠成一项）；目录不参与差异 / 解读 */
  isDir: boolean;
  /** 暂存那一侧增删了几行；null = 没统计出来（二进制 / 未跟踪） */
  stagedAdded: number | null;
  stagedRemoved: number | null;
  /** 工作区那一侧增删了几行 */
  unstagedAdded: number | null;
  unstagedRemoved: number | null;
}

export interface GitSnapshot {
  isRepo: boolean;
  branch: string | null;
  /** HEAD 的提交号；空仓库时是 null。变化即代表历史变了（提交/amend/reset/切换分支） */
  head: string | null;
  ahead: number;
  behind: number;
  /** 仓库正卡在一次没结束的多步操作里；为真时面板切成"进行中"界面 */
  merging: boolean;
  /** 进行中的具体操作类型；null = 没有进行中的操作 */
  mergeKind: "merge" | "rebase" | "cherryPick" | "revert" | null;
  /** 未合并（冲突）条目数，后端按 porcelain 的 u 记录数出来的 */
  conflicts: number;
  /** 改动条目总数；条目过多时可能大于 marks.size */
  changed: number;
  /** 文件绝对路径的归一化 key -> 标记，供文件树和标签页查 */
  marks: ReadonlyMap<string, GitMark>;
  /** 逐条原始记录，供改动列表分组 */
  changes: readonly GitChange[];
}

export interface GitController {
  snapshot: GitSnapshot;
  /** 立刻重新拉一次，不等下一个轮询周期 */
  refresh: () => void;
  /** 写操作已经把新状态带回来了，直接落地，省一次往返 */
  applyStatus: (payload: GitStatusPayload) => void;
}

const EMPTY: GitSnapshot = {
  isRepo: false,
  branch: null,
  head: null,
  ahead: 0,
  behind: 0,
  merging: false,
  mergeKind: null,
  conflicts: 0,
  changed: 0,
  marks: new Map(),
  changes: [],
};

/** 只看一个状态字母。判断顺序即优先级。 */
function markOfXY(xy: string): GitMark {
  // 冲突记录（u）的 XY 里一定有 U，比如 UU/AA/DU；
  // 但 AA（双方都新增）/ DD（双方都删）是例外，XY 里没有 U，得单独认
  if (xy.includes("U") || xy === "AA" || xy === "DD") return { label: "C", kind: "conflict" };
  if (xy.includes("?")) return { label: "U", kind: "untracked" };
  if (xy.includes("D")) return { label: "D", kind: "deleted" };
  if (xy.includes("A")) return { label: "A", kind: "added" };
  if (xy.includes("R")) return { label: "R", kind: "modified" };
  return { label: "M", kind: "modified" };
}

/** XY 两列合成一个字母：文件树和标签页要的是"一个文件一个字母" */
function markOf(index: string, worktree: string): GitMark {
  return markOfXY(`${index}${worktree}`);
}

/** 只看一列：暂存组传 X 列，未暂存组传 Y 列 */
export function markOfColumn(column: string): GitMark {
  return markOfXY(column);
}

/** 暂存区有内容 */
export function isStaged(change: GitChange): boolean {
  return change.index !== "." && change.index !== "?";
}

/** 工作区有内容（含未跟踪） */
export function isUnstaged(change: GitChange): boolean {
  return change.worktree !== ".";
}

/**
 * 这条改动是不是一个未合并（冲突）的文件。判据与上面的 markOfXY 保持一致：
 * XY 里含 `U`，或 XY 是 `AA`（双方都新增）/ `DD`（双方都删）——后两种 XY 里没有 U。
 */
export function isConflict(change: GitChange): boolean {
  const xy = `${change.index}${change.worktree}`;
  return xy.includes("U") || xy === "AA" || xy === "DD";
}

/**
 * 这条改动能不能被 `git stash push` 收走。
 *
 * 未跟踪的新文件（`?`）**不在** stash 的默认范围内（要收得加 `-u`，那会让文件从
 * 工作区消失，见后端 stash_push 的说明）。关键在于：只有未跟踪文件时 `git stash
 * push` 会打印 `No local changes to save` 却**以 0 退出**——不判一下的话，界面会
 * 给出一个点了什么也不发生的按钮。
 */
export function isStashable(change: GitChange): boolean {
  return isStaged(change) || (isUnstaged(change) && change.worktree !== "?");
}

/**
 * 同一路径可能同时出现在多条记录里（`git rm --cached` 之后既算删除又算未跟踪），
 * 只留最显眼的那条
 */
const RANK: Record<GitMarkKind, number> = {
  conflict: 5,
  deleted: 4,
  modified: 3,
  added: 2,
  untracked: 1,
};

function toSnapshot(payload: GitStatusPayload): GitSnapshot {
  const marks = new Map<string, GitMark>();
  const changes: GitChange[] = [];
  if (payload.isRepo) {
    for (const file of payload.files) {
      const mark = markOf(file.index, file.worktree);
      const key = pathKey(file.path);
      changes.push({
        path: file.path,
        relative: file.relative,
        index: file.index,
        worktree: file.worktree,
        isDir: file.isDir,
        stagedAdded: file.stagedAdded,
        stagedRemoved: file.stagedRemoved,
        unstagedAdded: file.unstagedAdded,
        unstagedRemoved: file.unstagedRemoved,
      });
      const previous = marks.get(key);
      if (previous && RANK[previous.kind] >= RANK[mark.kind]) continue;
      marks.set(key, mark);
    }
  }
  return {
    isRepo: payload.isRepo,
    branch: payload.branch,
    head: payload.head,
    ahead: payload.ahead,
    behind: payload.behind,
    merging: payload.merging,
    mergeKind: payload.mergeKind,
    conflicts: payload.conflicts,
    changed: payload.changed,
    marks,
    changes,
  };
}

/**
 * 一个工作区的 git 状态（可能挂着多个工作目录）。
 *
 * `byRoot` 是每根各一份快照；`marks` / `changed` / `isRepo` 是合并视图——文件树、
 * 标签页、图标条要的是「整个工作区现在什么样」，而变更面板要按根分开列。
 *
 * `enabled` 为 false 时**停掉轮询但保留已有状态**：一个窗口里会同时挂着多个工作区，
 * 只有当前显示的那个需要轮询，其余的一直在跑就是白烧 CPU。切回来时状态还是离开
 * 时的样子，再等一个 tick 就又准了。
 *
 * `withCounts` 为 false 时后端不跑 numstat（行数全是 null）：轮询每 2 秒一次，而行数
 * 只有「变更」面板会显示，面板没开时那两个 git 进程纯属浪费。它进了 effect 依赖，
 * 面板显隐一变就立刻按新口径重拉一次。
 *
 * 只读轮询：git 那侧没有任何写操作，命令带 --no-optional-locks，不会和用户
 * 在终端里敲的 git 抢 index 锁。写操作走 `applyStatus` 直接落地，不经过这里。
 */
export interface GitStatusStore {
  /** 根 -> 该根的快照。没轮到的根取不到，用 `snapshotOf` 兜底 */
  byRoot: Record<string, GitSnapshot>;
  /** 各根的 marks 合并（路径天然不重叠），文件树和标签页查它 */
  marks: ReadonlyMap<string, GitMark>;
  /** 各根改动条目之和，图标条上的徽标 */
  changed: number;
  /** 任意一根是仓库 */
  isRepo: boolean;
  /** 立刻重拉；不传 root 就拉全部 */
  refresh: (root?: string) => void;
  /** 某根的写操作已经把新状态带回来了，直接落地，省一次往返 */
  applyStatus: (root: string, payload: GitStatusPayload) => void;
}

export function useGitStatus(
  roots: string[],
  enabled = true,
  withCounts = true,
): GitStatusStore {
  const [byRoot, setByRoot] = useState<Record<string, GitSnapshot>>({});
  // 手动刷新要能调到当前这一轮 effect 里的 load，所以用 ref 转一手
  const loadRef = useRef<(root?: string, force?: boolean) => void>(() => {});
  const rootsKey = rootsKeyOf(roots);

  useEffect(() => {
    // 请求状态全放在 effect 里：停掉时整份作废，旧请求回来会被 disposed 丢掉，
    // 不会把上一个仓库的状态盖到新目录上
    const targets = roots;
    if (!enabled || targets.length === 0) {
      // 工作区切走了：只停轮询，**不清状态**——组件还挂着，切回来该是原样
      loadRef.current = () => {};
      return;
    }

    let disposed = false;
    /** 正在飞的根、以及 git 不可用（没装/超时）被停掉的根 */
    const inFlight = new Set<string>();
    const queued = new Set<string>();
    const unavailable = new Set<string>();

    const load = async (root: string, force = false) => {
      if (disposed || unavailable.has(root)) return;
      if (inFlight.has(root)) {
        // 正在飞的时候又来了刷新请求：记一笔，等它落地后补跑一次。
        // 既不丢刷新，也不会把请求堆起来
        if (force) queued.add(root);
        return;
      }
      inFlight.add(root);
      try {
        const payload = await gitStatus(root, withCounts);
        if (!disposed) setByRoot((current) => ({ ...current, [root]: toSnapshot(payload) }));
      } catch (reason) {
        if (disposed) return;
        // git 没装或超时：停掉这一根的轮询，免得每 2 秒白起一个进程。
        // "目录不是仓库"不是错误，那条路后端会正常返回 isRepo: false
        unavailable.add(root);
        console.warn(`git 状态不可用（${root}），已停止轮询：`, reason);
      } finally {
        inFlight.delete(root);
        if (queued.has(root) && !disposed) {
          queued.delete(root);
          void load(root);
        }
      }
    };

    loadRef.current = (root, force = false) => {
      if (root) void load(root, force);
      else for (const item of targets) void load(item, force);
    };
    loadRef.current(undefined, false);
    const timer = window.setInterval(() => loadRef.current(undefined, false), POLL_MS);
    // 从终端或别的窗口切回来时立刻补一次，不用干等下一个 tick
    const onFocus = () => loadRef.current(undefined, false);
    window.addEventListener("focus", onFocus);

    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [rootsKey, enabled, withCounts]);

  // 换过根之后把不在列表里的旧快照摘掉：不然改工作区留下的根会一直挂在状态里
  useEffect(() => {
    setByRoot((current) => {
      const keep = Object.keys(current).filter((root) =>
        roots.some((item) => pathKey(item) === pathKey(root)),
      );
      if (keep.length === Object.keys(current).length) return current;
      const next: Record<string, GitSnapshot> = {};
      for (const root of keep) next[root] = current[root];
      return next;
    });
  }, [rootsKey]);

  const merged = useMemo(() => {
    const marks = new Map<string, GitMark>();
    let changed = 0;
    let isRepo = false;
    for (const root of roots) {
      const snapshot = byRoot[root];
      if (!snapshot) continue;
      if (snapshot.isRepo) isRepo = true;
      changed += snapshot.changed;
      for (const [key, mark] of snapshot.marks) marks.set(key, mark);
    }
    return { marks, changed, isRepo };
  }, [byRoot, rootsKey]);

  const refresh = useCallback((root?: string) => loadRef.current(root, true), []);

  const applyStatus = useCallback((root: string, payload: GitStatusPayload) => {
    setByRoot((current) => ({ ...current, [root]: toSnapshot(payload) }));
  }, []);

  return useMemo(
    () => ({ byRoot, marks: merged.marks, changed: merged.changed, isRepo: merged.isRepo, refresh, applyStatus }),
    [byRoot, merged, refresh, applyStatus],
  );
}

/** 某根的控制器，交给 `GitChangesPane` 用（它的接口就是单根的） */
export function controllerOf(
  store: GitStatusStore,
  root: string,
): GitController {
  return {
    snapshot: store.byRoot[root] ?? EMPTY,
    refresh: () => store.refresh(root),
    applyStatus: (payload: GitStatusPayload) => store.applyStatus(root, payload),
  };
}
