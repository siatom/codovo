import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { gitStatus, pathKey } from "./fs";
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
}

export interface GitSnapshot {
  isRepo: boolean;
  branch: string | null;
  /** HEAD 的提交号；空仓库时是 null。变化即代表历史变了（提交/amend/reset/切换分支） */
  head: string | null;
  ahead: number;
  behind: number;
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
  changed: 0,
  marks: new Map(),
  changes: [],
};

/** 只看一个状态字母。判断顺序即优先级。 */
function markOfXY(xy: string): GitMark {
  // 冲突记录（u）的 XY 里一定有 U，比如 UU/AA/DU
  if (xy.includes("U")) return { label: "C", kind: "conflict" };
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
    changed: payload.changed,
    marks,
    changes,
  };
}

/**
 * 某个项目的 git 状态。
 *
 * `enabled` 为 false 时**停掉轮询但保留已有状态**：一个窗口里会同时挂着多个项目，
 * 只有当前显示的那个需要轮询，其余的一直在跑就是白烧 CPU。切回来时状态还是离开
 * 时的样子，再等一个 tick 就又准了。
 *
 * 只读轮询：git 那侧没有任何写操作，命令带 --no-optional-locks，不会和用户
 * 在终端里敲的 git 抢 index 锁。写操作走 GitController.applyStatus 直接落地，
 * 不经过这里。
 */
export function useGitStatus(root: string | null, enabled = true): GitController {
  const [snapshot, setSnapshot] = useState<GitSnapshot>(EMPTY);
  // 手动刷新要能调到当前这一轮 effect 里的 load，所以用 ref 转一手
  const loadRef = useRef<(force?: boolean) => void>(() => {});

  useEffect(() => {
    // 请求状态全放在 effect 里：停掉时整份作废，旧请求回来会被 disposed 丢掉，
    // 不会把上一个仓库的状态盖到新目录上
    let inFlight = false;
    let queued = false;
    let unavailable = false;
    let disposed = false;

    if (!root) {
      setSnapshot(EMPTY);
      loadRef.current = () => {};
      return;
    }
    if (!enabled) {
      // 这个项目切走了：只停轮询，**不清状态**——组件还挂着，切回来该是原样
      loadRef.current = () => {};
      return;
    }
    // 到这里 root 一定非空，收进局部变量，闭包里用着踏实
    const repoRoot = root;

    const load = async (force = false) => {
      if (disposed || unavailable) return;
      if (inFlight) {
        // 正在飞的时候又来了刷新请求：记一笔，等它落地后补跑一次。
        // 既不丢刷新，也不会把请求堆起来
        if (force) queued = true;
        return;
      }
      inFlight = true;
      try {
        const payload = await gitStatus(repoRoot);
        if (!disposed) setSnapshot(toSnapshot(payload));
      } catch (reason) {
        if (disposed) return;
        // git 没装或超时：停掉轮询，免得每 2 秒白起一个进程。
        // "目录不是仓库"不是错误，那条路后端会正常返回 isRepo: false
        unavailable = true;
        console.warn("git 状态不可用，已停止轮询：", reason);
      } finally {
        inFlight = false;
        if (queued && !disposed) {
          queued = false;
          void load();
        }
      }
    };

    loadRef.current = (force = false) => void load(force);
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    // 从终端或别的窗口切回来时立刻补一次，不用干等下一个 tick
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);

    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [root, enabled]);

  const refresh = useCallback(() => loadRef.current(true), []);

  const applyStatus = useCallback((payload: GitStatusPayload) => {
    setSnapshot(toSnapshot(payload));
  }, []);

  return useMemo(
    () => ({ snapshot, refresh, applyStatus }),
    [snapshot, refresh, applyStatus],
  );
}
