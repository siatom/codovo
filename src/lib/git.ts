import { useEffect, useRef, useState } from "react";
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

export interface GitSnapshot {
  isRepo: boolean;
  branch: string | null;
  ahead: number;
  behind: number;
  /** 改动条目总数；条目过多时可能大于 marks.size */
  changed: number;
  /** 文件绝对路径的归一化 key -> 标记 */
  marks: ReadonlyMap<string, GitMark>;
}

const EMPTY: GitSnapshot = {
  isRepo: false,
  branch: null,
  ahead: 0,
  behind: 0,
  changed: 0,
  marks: new Map(),
};

/** 把 porcelain v2 的 XY 翻译成一个字母。判断顺序即优先级。 */
function markOf(index: string, worktree: string): GitMark {
  const xy = `${index}${worktree}`;
  // 冲突记录（u）的 XY 里一定有 U，比如 UU/AA/DU
  if (xy.includes("U")) return { label: "C", kind: "conflict" };
  if (xy.includes("?")) return { label: "U", kind: "untracked" };
  if (xy.includes("D")) return { label: "D", kind: "deleted" };
  if (xy.includes("A")) return { label: "A", kind: "added" };
  if (xy.includes("R")) return { label: "R", kind: "modified" };
  return { label: "M", kind: "modified" };
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
  if (payload.isRepo) {
    for (const file of payload.files) {
      const mark = markOf(file.index, file.worktree);
      const key = pathKey(file.path);
      const previous = marks.get(key);
      if (previous && RANK[previous.kind] >= RANK[mark.kind]) continue;
      marks.set(key, mark);
    }
  }
  return {
    isRepo: payload.isRepo,
    branch: payload.branch,
    ahead: payload.ahead,
    behind: payload.behind,
    changed: payload.changed,
    marks,
  };
}

/**
 * 当前工作区的 git 状态。
 *
 * 只读、只轮询：git 那侧没有任何写操作，命令本身带 --no-optional-locks，
 * 不会和用户在终端里敲的 git 抢 index 锁。
 */
export function useGitStatus(root: string | null): GitSnapshot {
  const [snapshot, setSnapshot] = useState<GitSnapshot>(EMPTY);
  // git 都调不起来（没装、超时）时停掉轮询，免得每 2 秒白起一个进程
  const unavailable = useRef(false);
  // 上一次还没回来就跳过这一轮，慢仓库不至于把请求堆起来
  const inFlight = useRef(false);

  useEffect(() => {
    unavailable.current = false;
    inFlight.current = false;
    if (!root) {
      setSnapshot(EMPTY);
      return;
    }
    // 换工作区先把旧标记清掉，否则新目录会短暂顶着上一个仓库的状态
    setSnapshot(EMPTY);

    let cancelled = false;
    const load = async () => {
      if (cancelled || unavailable.current || inFlight.current) return;
      inFlight.current = true;
      try {
        const payload = await gitStatus();
        if (!cancelled) setSnapshot(toSnapshot(payload));
      } catch (reason) {
        if (cancelled) return;
        unavailable.current = true;
        console.warn("git 状态不可用，已停止轮询：", reason);
      } finally {
        inFlight.current = false;
      }
    };

    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    // 从终端或别的窗口切回来时立刻补一次，不用干等下一个 tick
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [root]);

  return snapshot;
}
