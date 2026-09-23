import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  gitCommit,
  gitCommitFiles,
  gitLog,
  gitStage,
  gitUnstage,
  pathKey,
  toDisplayPath,
} from "../lib/fs";
import {
  isStaged,
  isUnstaged,
  markOfColumn,
  type GitChange,
  type GitController,
  type GitMark,
} from "../lib/git";
import type { DiffSource } from "../lib/tabs";
import type { GitCommit, GitCommitFile, GitStatusPayload } from "../lib/types";
import { GitMarkBadge } from "./GitMarkBadge";
import {
  IconBranch,
  IconChevronDown,
  IconChevronRight,
  IconMinus,
  IconPlus,
  IconRefresh,
} from "./icons";

interface GitChangesPaneProps {
  git: GitController;
  /** 点改动项 / 提交里的文件：打开差异视图，source 决定跟谁比 */
  onOpen: (path: string, source: DiffSource) => void;
}

/** 提交历史一次拉多少条，「加载更多」再叠加 */
const LOG_PAGE = 50;

const LOG_COLLAPSED_KEY = "codedock.commitLogCollapsed";
const LOG_HEIGHT_KEY = "codedock.commitLogHeight";

/** 提交历史那块能拖到多高/多矮 */
const MIN_LOG_HEIGHT = 80;
const MAX_LOG_HEIGHT = 600;
const DEFAULT_LOG_HEIGHT = 224;

/** 上面至少要留出来的高度：工具条 + 提交框 + 两三行改动列表 */
const RESERVED_ABOVE = 200;

function readLogCollapsed(): boolean {
  try {
    return window.localStorage.getItem(LOG_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function readLogHeight(): number {
  try {
    const saved = Number(window.localStorage.getItem(LOG_HEIGHT_KEY));
    if (Number.isFinite(saved) && saved >= MIN_LOG_HEIGHT && saved <= MAX_LOG_HEIGHT) {
      return saved;
    }
  } catch {
    // 读不到就用默认值
  }
  return DEFAULT_LOG_HEIGHT;
}

/** 提交里的状态字母映射到徽标配色（`R`/`C` 沿用改动的黄色） */
function statusMark(status: string): GitMark {
  switch (status) {
    case "A":
      return { label: "A", kind: "added" };
    case "D":
      return { label: "D", kind: "deleted" };
    case "R":
      return { label: "R", kind: "modified" };
    case "C":
      return { label: "C", kind: "modified" };
    default:
      return { label: "M", kind: "modified" };
  }
}

/** 相对时间，够用就行——提交列表里不需要精确到分秒 */
function formatTime(seconds: number): string {
  const diff = Date.now() / 1000 - seconds;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;
  return new Date(seconds * 1000).toLocaleDateString();
}

function baseName(relative: string): string {
  const slash = relative.lastIndexOf("/");
  return slash === -1 ? relative : relative.slice(slash + 1);
}

function dirOf(relative: string): string {
  const slash = relative.lastIndexOf("/");
  return slash === -1 ? "" : relative.slice(0, slash);
}

const TEXT_INPUT =
  "w-full rounded-md border border-line-strong bg-surface px-2 py-1 text-[12px] text-fg outline-none focus:border-accent";

const COMMIT_BUTTON =
  "shrink-0 rounded border border-accent-line px-2 py-0.5 text-[11px] text-accent-soft hover:bg-active disabled:opacity-50";

const GROUP_ACTION =
  "shrink-0 rounded px-1.5 py-0.5 text-[11px] text-fg-faint hover:bg-hover hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent";

/** 行内操作按钮：平时藏起来，悬停或键盘聚焦时才出现并接受点击 */
const ROW_ACTION =
  "pointer-events-none flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-faint opacity-0 hover:text-fg focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 disabled:opacity-0";

/** 同一时刻只允许一个写操作在跑，否则会和自己的 index.lock 撞上 */
type Busy = null | "stage" | "unstage" | "commit";

function ChangeRow({
  change,
  staged,
  busy,
  onOpen,
  onToggle,
}: {
  change: GitChange;
  /** true = 在"暂存的改动"组里，行内按钮是取消暂存 */
  staged: boolean;
  busy: boolean;
  onOpen: (path: string, source: DiffSource) => void;
  onToggle: (path: string) => void;
}) {
  const slash = change.relative.lastIndexOf("/");
  const name = slash === -1 ? change.relative : change.relative.slice(slash + 1);
  const dir = slash === -1 ? "" : change.relative.slice(0, slash);
  // 暂存组看 X 列，未暂存组看 Y 列：`AM` 在两组里该显示成不同的字母
  const mark = markOfColumn(staged ? change.index : change.worktree);

  return (
    <div className="group flex items-center gap-1.5 rounded px-1 py-[3px] text-[12px] hover:bg-hover">
      <button
        type="button"
        onClick={() =>
          onOpen(change.path, staged ? { mode: "staged" } : { mode: "unstaged" })
        }
        title={toDisplayPath(change.path)}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
      >
        <span className="min-w-0 truncate text-fg-muted">{name}</span>
        {dir && <span className="min-w-0 truncate text-[11px] text-fg-faint">{dir}</span>}
      </button>
      <GitMarkBadge mark={mark} className="text-[10px]" />
      <button
        type="button"
        onClick={() => onToggle(change.path)}
        disabled={busy}
        title={staged ? "取消暂存" : "暂存"}
        className={ROW_ACTION}
      >
        {staged ? <IconMinus className="h-3 w-3" /> : <IconPlus className="h-3 w-3" />}
      </button>
    </div>
  );
}

/**
 * 一条提交：点一下就地展开它改了哪些文件，再点收起。
 * 展开的文件点进去看的是「这个提交 vs 它的父提交」的差异。
 */
function CommitRow({
  commit,
  expanded,
  files,
  onToggle,
  onOpen,
}: {
  commit: GitCommit;
  expanded: boolean;
  /** undefined = 还没拉到 */
  files: GitCommitFile[] | undefined;
  onToggle: () => void;
  onOpen: (path: string, source: DiffSource) => void;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        title={`${commit.subject}\n${commit.author} · ${formatTime(commit.time)}\n${commit.hash}`}
        className="flex w-full items-center gap-1.5 rounded px-1 py-[3px] text-left text-[11px] hover:bg-hover"
      >
        {expanded ? (
          <IconChevronDown className="h-3 w-3 shrink-0 text-fg-faint" />
        ) : (
          <IconChevronRight className="h-3 w-3 shrink-0 text-fg-faint" />
        )}
        <span className="shrink-0 font-mono text-fg-faint">{commit.short}</span>
        <span className="min-w-0 flex-1 truncate text-fg-muted">{commit.subject}</span>
      </button>

      {expanded && files === undefined && (
        <p className="py-[3px] pl-6 text-[11px] text-fg-faint">加载中…</p>
      )}
      {expanded && files?.length === 0 && (
        <p className="py-[3px] pl-6 text-[11px] text-fg-faint">这个提交没有文件改动</p>
      )}
      {expanded && files && files.length > 0 && (
        <ul>
          {files.map((file) => (
            <li key={file.path}>
              <button
                type="button"
                onClick={() => onOpen(file.path, { mode: "commit", rev: commit.hash })}
                title={file.relative}
                className="flex w-full items-center gap-1.5 rounded py-[3px] pr-1 pl-6 text-left text-[11px] hover:bg-hover"
              >
                <span className="min-w-0 truncate text-fg-muted">{baseName(file.relative)}</span>
                {dirOf(file.relative) && (
                  <span className="min-w-0 truncate text-[10px] text-fg-faint">
                    {dirOf(file.relative)}
                  </span>
                )}
                <GitMarkBadge mark={statusMark(file.status)} className="text-[10px]" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * 改动列表 + 提交框 + 提交历史，右栏「变更」模块的整屏内容。
 * 目录不是仓库（或系统里没有 git）时整个不渲染——工具列表那边已经把这行置灰了，
 * 这里的早退只是兜底。
 */
export function GitChangesPane({ git, onOpen }: GitChangesPaneProps) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);

  // 提交历史
  const [logCollapsed, setLogCollapsed] = useState(readLogCollapsed);
  const [logHeight, setLogHeight] = useState(readLogHeight);
  const [draggingLog, setDraggingLog] = useState(false);
  /** 拖动起点，null 表示没在拖 */
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [logLimit, setLogLimit] = useState(LOG_PAGE);
  /** null = 还没拉到 */
  const [commits, setCommits] = useState<GitCommit[] | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  /** 展开的那条提交 */
  const [openCommit, setOpenCommit] = useState<string | null>(null);
  const [commitFiles, setCommitFiles] = useState<ReadonlyMap<string, GitCommitFile[]>>(new Map());
  /** 提交完 / 手动刷新时 +1，用来重拉历史 */
  const [logRevision, setLogRevision] = useState(0);

  const { snapshot, refresh, applyStatus } = git;
  const { changes } = snapshot;

  const staged = useMemo(() => changes.filter(isStaged), [changes]);
  const unstaged = useMemo(() => changes.filter(isUnstaged), [changes]);

  /** 写操作统一走这里：全程禁用其它写按钮，失败就把 git 的报错摆出来 */
  const run = useCallback(
    async (kind: Exclude<Busy, null>, task: () => Promise<GitStatusPayload>) => {
      setBusy(kind);
      setError(null);
      try {
        // 写命令已经把新状态带回来了，直接落地，不用等下一个轮询周期
        applyStatus(await task());
      } catch (reason) {
        setError(String(reason));
      } finally {
        setBusy(null);
      }
    },
    [applyStatus],
  );

  const commit = useCallback(() => {
    if (!message.trim()) return;
    void run("commit", async () => {
      const payload = await gitCommit(message);
      setMessage(""); // 只有真提交成功才清空
      setLogRevision((revision) => revision + 1); // 刚多了一条提交
      return payload;
    });
  }, [message, run]);

  /** 手动刷新：状态和历史一起重拉，省得再放一个按钮 */
  const reloadAll = useCallback(() => {
    refresh();
    setLogRevision((revision) => revision + 1);
  }, [refresh]);

  const setLogCollapsedPersisted = (next: boolean) => {
    setLogCollapsed(next);
    try {
      window.localStorage.setItem(LOG_COLLAPSED_KEY, next ? "1" : "0");
    } catch {
      // 记不住就按展开算，不影响使用
    }
  };

  /**
   * 拖动提交历史的上边缘改高度。
   * 走指针捕获而不是监听 window：指针移出这个 1px 的细条后照样收得到事件。
   */
  const onHandleDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { startY: event.clientY, startHeight: logHeight };
    setDraggingLog(true);
    document.body.classList.add("codedock-dragging-row");
  };

  const onHandleMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    // 上限还要看面板本身有多高，否则能把上面那块挤没
    const room = (panelRef.current?.clientHeight ?? 0) - RESERVED_ABOVE;
    const limit = Math.max(MIN_LOG_HEIGHT, Math.min(MAX_LOG_HEIGHT, room));
    const next = drag.startHeight - (event.clientY - drag.startY);
    setLogHeight(Math.min(limit, Math.max(MIN_LOG_HEIGHT, next)));
  };

  const onHandleUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
    setDraggingLog(false);
    document.body.classList.remove("codedock-dragging-row");
    try {
      // 用 state 里最新的值：拖动过程中它一直在变
      window.localStorage.setItem(LOG_HEIGHT_KEY, String(logHeight));
    } catch {
      // 记不住就下次还是默认高度
    }
  };

  // 拉提交历史。收起时完全不请求——这个面板收起是常态，别白跑 git
  useEffect(() => {
    if (logCollapsed) return;
    let cancelled = false;
    void gitLog(logLimit)
      .then((list) => {
        if (cancelled) return;
        setCommits(list);
        setLogError(null);
      })
      .catch((reason) => {
        if (cancelled) return;
        setCommits([]);
        setLogError(String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [logCollapsed, logLimit, logRevision]);

  // 展开某条提交时才去拉它的文件列表，拉过就留着
  useEffect(() => {
    if (!openCommit || commitFiles.has(openCommit)) return;
    let cancelled = false;
    void gitCommitFiles(openCommit)
      .then((list) => {
        if (!cancelled) setCommitFiles((current) => new Map(current).set(openCommit, list));
      })
      .catch(() => {
        // 拿不到就当空列表，展开的那行会显示"没有文件改动"
        if (!cancelled) setCommitFiles((current) => new Map(current).set(openCommit, []));
      });
    return () => {
      cancelled = true;
    };
  }, [openCommit, commitFiles]);

  const toggleCommit = useCallback((hash: string) => {
    setOpenCommit((current) => (current === hash ? null : hash));
  }, []);

  const onMessageKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter 留给换行（提交信息常常是多行），提交用 Ctrl/Cmd+Enter
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      commit();
    }
  };

  if (!snapshot.isRepo) return null;

  const canCommit = staged.length > 0 && message.trim().length > 0 && busy === null;

  return (
    <div ref={panelRef} className="flex h-full min-h-0 flex-col">
      <header className="flex h-8 shrink-0 items-center gap-1.5 border-b border-line px-3">
        <IconBranch className="h-3 w-3 text-fg-dim" />
        <span
          className="min-w-0 flex-1 truncate text-[11px] text-fg-dim"
          title={snapshot.branch ?? "游离 HEAD"}
        >
          {snapshot.branch ?? "游离 HEAD"}
        </span>
        <button
          type="button"
          onClick={reloadAll}
          title="刷新"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-dim hover:bg-active hover:text-fg"
        >
          <IconRefresh className="h-3.5 w-3.5" />
        </button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-1.5 px-2 py-2">
        <textarea
          rows={2}
          value={message}
          onChange={(event) => {
            setMessage(event.target.value);
            if (error) setError(null);
          }}
          onKeyDown={onMessageKeyDown}
          placeholder="提交信息（Ctrl+Enter 提交）"
          className={`${TEXT_INPUT} resize-none`}
        />

        <div className="flex shrink-0 items-center gap-2">
          <button type="button" onClick={commit} disabled={!canCommit} className={COMMIT_BUTTON}>
            {busy === "commit" ? "提交中…" : "提交"}
          </button>
          {staged.length === 0 && (
            <span className="min-w-0 truncate text-[11px] text-fg-faint">
              先暂存要提交的改动
            </span>
          )}
        </div>

        {error && (
          <p className="shrink-0 rounded border border-danger-line bg-danger-bg px-2 py-1 text-[11px] whitespace-pre-wrap text-danger">
            {error}
          </p>
        )}

        <div className="min-h-0 flex-1 overflow-auto">
          {staged.length === 0 && unstaged.length === 0 && (
            <p className="px-1 py-1 text-[11px] text-fg-faint">没有未提交的改动</p>
          )}

          {staged.length > 0 && (
            <>
              <div className="flex items-center gap-1 px-1 pt-1 pb-0.5">
                <span className="min-w-0 flex-1 truncate text-[11px] text-fg-faint">
                  暂存的改动 ({staged.length})
                </span>
                <button
                  type="button"
                  onClick={() => void run("unstage", () => gitUnstage())}
                  disabled={busy !== null}
                  title="全部取消暂存"
                  className={GROUP_ACTION}
                >
                  全部取消
                </button>
              </div>
              {staged.map((change) => (
                <ChangeRow
                  key={`staged:${pathKey(change.path)}`}
                  change={change}
                  staged
                  busy={busy !== null}
                  onOpen={onOpen}
                  onToggle={(path) => void run("unstage", () => gitUnstage([path]))}
                />
              ))}
            </>
          )}

          {unstaged.length > 0 && (
            <>
              <div className="flex items-center gap-1 px-1 pt-1.5 pb-0.5">
                <span className="min-w-0 flex-1 truncate text-[11px] text-fg-faint">
                  改动 ({unstaged.length})
                </span>
                <button
                  type="button"
                  onClick={() => void run("stage", () => gitStage())}
                  disabled={busy !== null}
                  title="全部暂存"
                  className={GROUP_ACTION}
                >
                  全部暂存
                </button>
              </div>
              {unstaged.map((change) => (
                <ChangeRow
                  // 同一文件可能同时出现在两组里（`MM`），key 得带组名
                  key={`unstaged:${pathKey(change.path)}`}
                  change={change}
                  staged={false}
                  busy={busy !== null}
                  onOpen={onOpen}
                  onToggle={(path) => void run("stage", () => gitStage([path]))}
                />
              ))}
            </>
          )}
        </div>
      </div>

      {/* 拖动条把提交历史的上边缘变成可拖的：往下拖历史变高。
          收起时不画——没有东西可调 */}
      {!logCollapsed && (
        <div
          role="separator"
          aria-orientation="horizontal"
          onPointerDown={onHandleDown}
          onPointerMove={onHandleMove}
          onPointerUp={onHandleUp}
          onPointerCancel={onHandleUp}
          title="拖动调整提交历史的高度"
          className={`relative h-px shrink-0 cursor-row-resize bg-line-strong transition-colors ${
            draggingLog ? "bg-accent-strong" : "hover:bg-line-hover"
          }`}
        >
          {/* 加宽命中区，视觉上仍是一条细线 */}
          <span className="absolute inset-x-0 -top-1 -bottom-1" />
        </div>
      )}

      {/* 提交历史。改完的东西在上一区，翻过的旧账在下面，别再挤同一块滚动区 */}
      <div
        className="flex min-h-0 shrink-0 flex-col"
        style={logCollapsed ? undefined : { height: logHeight }}
      >
        <button
          type="button"
          onClick={() => setLogCollapsedPersisted(!logCollapsed)}
          title={logCollapsed ? "展开提交历史" : "收起提交历史"}
          className="flex h-7 w-full shrink-0 items-center gap-1 px-2 text-left text-[11px] font-medium tracking-wide text-fg-dim hover:text-fg"
        >
          {logCollapsed ? (
            <IconChevronRight className="h-3 w-3" />
          ) : (
            <IconChevronDown className="h-3 w-3" />
          )}
          <span>提交历史</span>
          {commits && commits.length > 0 && (
            <span className="text-fg-faint">{commits.length}</span>
          )}
        </button>

        {!logCollapsed && (
          <div className="min-h-0 flex-1 overflow-auto px-1 pb-2">
            {logError && <p className="px-1 py-1 text-[11px] text-danger">{logError}</p>}
            {commits === null && !logError && (
              <p className="px-1 py-1 text-[11px] text-fg-faint">加载中…</p>
            )}
            {commits?.length === 0 && !logError && (
              <p className="px-1 py-1 text-[11px] text-fg-faint">还没有提交</p>
            )}

            {commits?.map((commit) => (
              <CommitRow
                key={commit.hash}
                commit={commit}
                expanded={openCommit === commit.hash}
                files={commitFiles.get(commit.hash)}
                onToggle={() => toggleCommit(commit.hash)}
                onOpen={onOpen}
              />
            ))}

            {commits && commits.length >= logLimit && (
              <button
                type="button"
                onClick={() => setLogLimit((limit) => limit + LOG_PAGE)}
                className={`${GROUP_ACTION} mt-1 ml-1`}
              >
                加载更多
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
