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
  gitDiscard,
  gitFetch,
  gitLog,
  gitPull,
  gitPush,
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
import { generateCommitMessage } from "../lib/ai";
import { useSettings } from "../lib/settings";
import type { DiffSource } from "../lib/tabs";
import type { GitCommit, GitCommitFile, GitStatusPayload, DiscardSource } from "../lib/types";
import { GitMarkBadge } from "./GitMarkBadge";
import { ConfirmDialog } from "./ConfirmDialog";
import {
  IconArrowDownToLine,
  IconArrowUpFromLine,
  IconBranch,
  IconChevronDown,
  IconChevronRight,
  IconCloudDownload,
  IconMinus,
  IconPlus,
  IconRefresh,
  IconSparkle,
  IconSync,
  IconUndo,
} from "./icons";

interface GitChangesPaneProps {
  git: GitController;
  /** 点改动项 / 提交里的文件：打开差异视图，source 决定跟谁比 */
  onOpen: (path: string, source: DiffSource) => void;
}

/** 待确认的放弃修改。确认框弹出前先把要放弃的东西记在这里 */
interface PendingDiscard {
  paths: string[];
  source: DiscardSource;
  /** 展示用：文件名，或者"N 个文件" */
  what: string;
}

/** 提交历史一次拉多少条，「加载更多」再叠加 */
const LOG_PAGE = 50;

/** 提交框最多长到几行，再高就改成滚动。默认只有一行，内容折行后自己长 */
const MESSAGE_MAX_ROWS = 5;

/** 手动拖高时，下面至少要留出来的空间：按钮行 + 报错位 + 两三行改动列表 */
const MESSAGE_RESERVED_BELOW = 160;

/**
 * 提交框的行高 / 内边距 / 边框。把"几行"和像素互相换算要用它。
 * 行高必须先定死（textarea 上有 `leading-4`）：不写死的话 getComputedStyle
 * 会返回 "normal"，算不出"几行"是多少像素。
 */
function messageMetrics(el: HTMLTextAreaElement) {
  const styles = window.getComputedStyle(el);
  const line = Number.parseFloat(styles.lineHeight);
  const border =
    Number.parseFloat(styles.borderTopWidth) + Number.parseFloat(styles.borderBottomWidth);
  const padding =
    Number.parseFloat(styles.paddingTop) + Number.parseFloat(styles.paddingBottom);
  return { line, border, padding, oneRow: line + padding + border };
}

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

/**
 * 主操作（提交 / 同步更改）：面板里同一位置的按钮会在这两个动作间切换，
 * 所以样式共用一套——实心整宽，和右栏其它主按钮一致。
 */
const PRIMARY_BUTTON =
  "flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-app hover:opacity-90 disabled:opacity-40 disabled:hover:opacity-40";

/** AI 生成：塞进提交框内部的纯图标按钮，居中对齐、平时淡、悬停才亮 */
const GENERATE_ICON =
  "absolute top-1/2 right-1 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-fg-dim hover:bg-active hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-dim";

const GROUP_ACTION =
  "shrink-0 rounded px-1.5 py-0.5 text-[11px] text-fg-faint hover:bg-hover hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent";

/** 分组标题右侧的批量操作：做成纯图标，和行内那组图标按钮同一套观感 */
const GROUP_ICON =
  "flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-faint hover:bg-hover hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-faint";

/** 批量放弃是破坏性操作：平时同上，悬停时才转成危险色 */
const GROUP_ICON_DANGER =
  "flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-faint hover:bg-hover hover:text-danger disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-faint";

/** 行内操作按钮：平时藏起来，悬停或键盘聚焦时才出现并接受点击 */
const ROW_ACTION =
  "pointer-events-none flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-faint opacity-0 hover:text-fg focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 disabled:opacity-0";

/** 行内的放弃修改：同样是悬停才出现，悬停转危险色 */
const ROW_DANGER =
  "pointer-events-none flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-faint opacity-0 hover:text-danger focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 disabled:opacity-0";

/** 同一时刻只允许一个写操作在跑，否则会和自己的 index.lock 撞上。
 *  generate 不是写操作，但同样在跑的时候得把按钮禁掉，免得连点发好几次请求。
 *  fetch/pull/push 是网络操作，跑起来可能要几分钟，更不能叠着发。 */
type Busy =
  | null
  | "stage"
  | "unstage"
  | "discard"
  | "commit"
  | "generate"
  | "fetch"
  | "pull"
  | "push";

/**
 * 能不能「放弃修改」。
 *
 * 新文件放弃等于把文件删掉（HEAD 里没有这个路径，还原过去就是删），
 * 和"未跟踪文件不给按钮"是同一条理由：不做会删文件的破坏性操作。
 * 未跟踪的 `?`、暂存区里新增的 `A` 都排除掉。空仓库里所有暂存文件都是 `A`，
 * 所以空仓库天然不支持放弃暂存改动。
 */
function canDiscard(change: GitChange, staged: boolean): boolean {
  return staged ? change.index !== "A" : change.worktree !== "?";
}

/** 标题栏那几个图标按钮的样式，和刷新按钮同一套 */
const HEADER_ACTION =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-dim hover:bg-active hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-dim";

/** 网络操作可能要跑几分钟，光靠按钮变灰看不出在干什么，下面补一行字 */
const SYNC_NOTICE = {
  fetch: "正在获取远程更新…",
  pull: "正在拉取…",
  push: "正在推送…",
} as const;

function ChangeRow({
  change,
  staged,
  busy,
  onOpen,
  onToggle,
  onDiscard,
}: {
  change: GitChange;
  /** true = 在"暂存的改动"组里，行内按钮是取消暂存 */
  staged: boolean;
  busy: boolean;
  onOpen: (path: string, source: DiffSource) => void;
  onToggle: (path: string) => void;
  onDiscard: (path: string) => void;
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
      {/* 右侧这一串（状态徽标 + 操作图标）单独成组：行上的 gap-1.5 对它们太松，
          组内压到 gap-0.5 更紧凑；命中区仍是 20px，不为了紧凑牺牲点击 */}
      <div className="flex shrink-0 items-center gap-0.5">
        <GitMarkBadge mark={mark} className="text-[10px]" />
        {/* 放弃修改排在暂存按钮左边（和 VS Code 一致）。它带确认，误点还能取消 */}
        {canDiscard(change, staged) && (
          <button
            type="button"
            onClick={() => onDiscard(change.path)}
            disabled={busy}
            title={staged ? "放弃修改（还原到 HEAD）" : "放弃修改（还原到暂存区）"}
            className={ROW_DANGER}
          >
            <IconUndo className="h-3 w-3" />
          </button>
        )}
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
        <p className="py-[3px] pl-6 text-[11px] text-fg-faint">这个提交没有文件更改</p>
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
  const [pendingDiscard, setPendingDiscard] = useState<PendingDiscard | null>(null);
  /**
   * null = 随内容长高（也就是默认的一行）；拖过之后是固定高度（px），内容多了自己滚动。
   * 高度不落盘：每次进应用都从一行起步，省得某次拖高之后再也回不到默认。
   */
  const [messageHeight, setMessageHeight] = useState<number | null>(null);
  const [draggingMessage, setDraggingMessage] = useState(false);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  /** 提交框拖动的起点，null 表示没在拖 */
  const messageDragRef = useRef<{ startY: number; startHeight: number } | null>(null);

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
  const { settings } = useSettings();
  const { changes } = snapshot;

  const staged = useMemo(() => changes.filter(isStaged), [changes]);
  const unstaged = useMemo(() => changes.filter(isUnstaged), [changes]);
  // 「全部放弃」只覆盖能放弃的那些，新文件不在内（见 canDiscard）
  const stagedDiscardable = useMemo(
    () => staged.filter((change) => canDiscard(change, true)),
    [staged],
  );
  const unstagedDiscardable = useMemo(
    () => unstaged.filter((change) => canDiscard(change, false)),
    [unstaged],
  );

  /** 写操作统一走这里：全程禁用其它写按钮，失败就把 git 的报错摆出来 */
  const run = useCallback(
    async (kind: Exclude<Busy, null>, task: () => Promise<GitStatusPayload | void>) => {
      setBusy(kind);
      setError(null);
      try {
        // 写命令已经把新状态带回来了，直接落地，不用等下一个轮询周期；
        // 生成只填提交框、不动 git，返回空值时就跳过状态更新
        const payload = await task();
        if (payload) applyStatus(payload);
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

  /**
   * 让 AI 生成提交信息填进框里由用户自己确认，不自动提交。
   *
   * 暂存区空着、但工作区有改动时，先把改动全部暂存再生成——否则 `diff --cached`
   * 是空的，什么也生成不出来。只要有暂存（哪怕只是部分），就只按暂存区生成，
   * 不擅自把剩下那些没暂存的改动也带上。
   */
  const generate = useCallback(() => {
    const { aiBaseUrl, aiModel, aiApiKey } = settings;
    if (!aiBaseUrl.trim() || !aiModel.trim() || !aiApiKey.trim()) {
      setError("请先在「设置 → AI」里填写接口地址、模型和密钥");
      return;
    }
    const stageAllFirst = staged.length === 0 && unstaged.length > 0;
    void run("generate", async () => {
      // 暂存返回新状态，跟着一起落地，免得按钮还停在"未暂存"的旧状态上
      const payload = stageAllFirst ? await gitStage() : undefined;
      setMessage(
        await generateCommitMessage({
          baseUrl: aiBaseUrl.trim(),
          apiKey: aiApiKey.trim(),
          model: aiModel.trim(),
        }),
      );
      return payload;
    });
  }, [settings, run, staged.length, unstaged.length]);

  /** 手动刷新：状态和历史一起重拉，省得再放一个按钮 */
  const reloadAll = useCallback(() => {
    refresh();
    setLogRevision((revision) => revision + 1);
  }, [refresh]);

  /** 只取回引用，不动工作区，所以提交历史不用重拉 */
  const fetch = useCallback(() => {
    void run("fetch", gitFetch);
  }, [run]);

  const pull = useCallback(() => {
    void run("pull", async () => {
      const payload = await gitPull();
      setLogRevision((revision) => revision + 1); // 快进之后历史多了一段
      return payload;
    });
  }, [run]);

  /** 推送不动本地历史，只变了 ahead/behind，状态由 run() 落地 */
  const push = useCallback(() => {
    void run("push", gitPush);
  }, [run]);

  /**
   * 放弃修改不可撤销，落手前先记下来弹确认框，用户点了才真跑。
   * `what` 是"哪个文件"或者"N 个文件"。
   * 新文件不会走到这里——它们根本没有按钮（见 canDiscard）。
   */
  const discard = useCallback((paths: string[], source: DiscardSource, what: string) => {
    setPendingDiscard({ paths, source, what });
  }, []);

  const confirmDiscard = useCallback(() => {
    const pending = pendingDiscard;
    if (!pending) return;
    setPendingDiscard(null);
    void run("discard", () => gitDiscard(pending.paths, pending.source));
  }, [pendingDiscard, run]);

  const discardAllStaged = useCallback(() => {
    discard(
      stagedDiscardable.map((change) => change.path),
      { mode: "staged" },
      `${stagedDiscardable.length} 个文件`,
    );
  }, [discard, stagedDiscardable]);

  const discardAllUnstaged = useCallback(() => {
    discard(
      unstagedDiscardable.map((change) => change.path),
      { mode: "unstaged" },
      `${unstagedDiscardable.length} 个文件`,
    );
  }, [discard, unstagedDiscardable]);

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

  /**
   * 拖动提交框的下边缘改高度，和上面拖历史那条是同一套写法。
   *
   * 从当前实际高度起拖：没拖过时框是随内容长高的，高度不是 state，
   * 得从 DOM 现量，否则一按下去就会跳成上次存的像素值。
   */
  const onMessageHandleDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const height = messageRef.current?.getBoundingClientRect().height ?? 0;
    messageDragRef.current = { startY: event.clientY, startHeight: height };
    setDraggingMessage(true);
    document.body.classList.add("codedock-dragging-row");
  };

  const onMessageHandleMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = messageDragRef.current;
    const el = messageRef.current;
    if (!drag || !el) return;
    // 下限一行，上限看面板本身有多高——不然能把下面的改动列表挤没
    const { oneRow } = messageMetrics(el);
    const room = (panelRef.current?.clientHeight ?? 0) - MESSAGE_RESERVED_BELOW;
    const limit = Math.max(oneRow, room);
    const next = drag.startHeight + (event.clientY - drag.startY);
    setMessageHeight(Math.min(limit, Math.max(oneRow, next)));
  };

  const onMessageHandleUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!messageDragRef.current) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    messageDragRef.current = null;
    setDraggingMessage(false);
    document.body.classList.remove("codedock-dragging-row");
  };

  // 拉提交历史。收起时完全不请求——这个面板收起是常态，别白跑 git。
  // 还要盯住 HEAD：在终端里 commit / amend / reset 之后，改动列表靠 2 秒轮询
  // 能自己变好，历史不会，只有 HEAD 动了才说明提交列表该重拉。
  useEffect(() => {
    if (logCollapsed || !snapshot.isRepo) return;
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
  }, [logCollapsed, logLimit, logRevision, snapshot.isRepo, snapshot.head]);

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

  /**
   * 提交框跟着内容长高，长到 MESSAGE_MAX_ROWS 行封顶，再多就滚动。
   *
   * 用 scrollHeight 量而不是数换行符：一行文字放不下时会自动折行，
   * 数 \n 得不出真实行数。`leading-4` 是量高度的前提——行高不定死的话
   * getComputedStyle 会返回 "normal"，算不出"几行"是多少像素。
   */
  const resizeMessage = useCallback(() => {
    // 手动拖过高度之后就不再随内容长高了：否则一打字就把用户调好的高度顶回去
    if (messageHeight !== null) return;
    const el = messageRef.current;
    if (!el) return;
    const styles = window.getComputedStyle(el);
    const line = Number.parseFloat(styles.lineHeight);
    const border =
      Number.parseFloat(styles.borderTopWidth) + Number.parseFloat(styles.borderBottomWidth);
    const max =
      line * MESSAGE_MAX_ROWS +
      Number.parseFloat(styles.paddingTop) +
      Number.parseFloat(styles.paddingBottom) +
      border;
    // box-sizing 是 border-box，指定高度含边框；scrollHeight 只量到 padding 为止
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight + border, max)}px`;
  }, [messageHeight]);

  useEffect(resizeMessage, [message, resizeMessage]);

  // 面板被拖宽/拖窄时折行位置会变，得重新量一次。监听面板而不是 textarea 自己：
  // 我们改的正是 textarea 的高度，监听它会自己触发自己
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const observer = new ResizeObserver(resizeMessage);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [resizeMessage]);

  if (!snapshot.isRepo) return null;

  const canCommit = staged.length > 0 && message.trim().length > 0 && busy === null;
  // 有暂存就按暂存生成；只有未暂存的改动也能生成（点下去会先全部暂存）
  const canGenerate = (staged.length > 0 || unstaged.length > 0) && busy === null;
  // 改动全都提交完了、本地还领先上游：主按钮从「提交」切成「同步更改」
  const showSync = staged.length === 0 && unstaged.length === 0 && snapshot.ahead > 0;
  const notice =
    busy === "fetch" || busy === "pull" || busy === "push" ? SYNC_NOTICE[busy] : null;

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

        {/* 领先/落后上游的提交数：只在非零时出现（没有上游时天然是 0），
            紧挨着拉取/推送按钮，一眼能看出该点哪个 */}
        {snapshot.ahead > 0 && (
          <span className="shrink-0 text-[11px] text-fg-faint" title="领先上游的提交数">
            ↑{snapshot.ahead}
          </span>
        )}
        {snapshot.behind > 0 && (
          <span className="shrink-0 text-[11px] text-fg-faint" title="落后上游的提交数">
            ↓{snapshot.behind}
          </span>
        )}

        {/* 四个图标按钮单独成组：header 的 gap-1.5 对它们太松，
            组内压到 gap-0.5 更像一组操作；命中区仍是 24px，不为了紧凑牺牲点击 */}
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={fetch}
            disabled={busy !== null}
            title="获取远程更新"
            className={HEADER_ACTION}
          >
            <IconCloudDownload
              className={`h-3.5 w-3.5 ${busy === "fetch" ? "animate-pulse" : ""}`}
            />
          </button>
          <button
            type="button"
            onClick={pull}
            disabled={busy !== null}
            title="拉取（只允许快进）"
            className={HEADER_ACTION}
          >
            <IconArrowDownToLine
              className={`h-3.5 w-3.5 ${busy === "pull" ? "animate-pulse" : ""}`}
            />
          </button>
          <button
            type="button"
            onClick={push}
            disabled={busy !== null}
            title="推送"
            className={HEADER_ACTION}
          >
            <IconArrowUpFromLine
              className={`h-3.5 w-3.5 ${busy === "push" ? "animate-pulse" : ""}`}
            />
          </button>

          <button
            type="button"
            onClick={reloadAll}
            title="刷新"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-dim hover:bg-active hover:text-fg"
          >
            <IconRefresh className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-1.5 px-2 py-2">
        {/* 生成按钮放进输入框内部右侧，外面那排整条让给主操作（提交 / 同步） */}
        <div className="relative shrink-0">
          <textarea
            ref={messageRef}
            rows={1}
            value={message}
            onChange={(event) => {
              setMessage(event.target.value);
              if (error) setError(null);
            }}
            onKeyDown={onMessageKeyDown}
            placeholder="消息（Ctrl+Enter）"
            style={messageHeight === null ? undefined : { height: messageHeight }}
            className={`${TEXT_INPUT} block resize-none pr-8 leading-4`}
          />
          <button
            type="button"
            onClick={generate}
            disabled={!canGenerate}
            title="用 AI 生成提交信息（没有暂存时会先全部暂存）"
            className={GENERATE_ICON}
          >
            <IconSparkle
              className={`h-3.5 w-3.5 ${busy === "generate" ? "animate-pulse" : ""}`}
            />
          </button>
        </div>

        {/* 拖动条改提交框高度：拖过之后高度定死，内容多了框内自己滚动。
            手柄做成本身就有 6px 高、再用负边距把上下 gap-1.5 抵消掉，
            这样命中区够大又不多占地方；不额外铺透明层——那会盖住文本框底边收不到点击 */}
        <div
          role="separator"
          aria-orientation="horizontal"
          onPointerDown={onMessageHandleDown}
          onPointerMove={onMessageHandleMove}
          onPointerUp={onMessageHandleUp}
          onPointerCancel={onMessageHandleUp}
          title="拖动调整提交框的高度"
          className={`-my-1.5 h-1.5 shrink-0 cursor-row-resize rounded-full transition-colors ${
            draggingMessage ? "bg-accent-strong" : "hover:bg-line-hover"
          }`}
        />

        <div className="flex shrink-0 items-center">
          {staged.length > 0 ? (
            <button type="button" onClick={commit} disabled={!canCommit} className={PRIMARY_BUTTON}>
              {busy === "commit" ? "提交中…" : "提交"}
            </button>
          ) : showSync ? (
            // 改动都提交完了、本地还领先上游：主操作顺势变成把提交推上去
            <button
              type="button"
              onClick={push}
              disabled={busy !== null}
              className={PRIMARY_BUTTON}
            >
              <IconSync className={`h-3.5 w-3.5 ${busy === "push" ? "animate-spin" : ""}`} />
              {busy === "push" ? "同步中…" : `同步更改 ${snapshot.ahead} 个`}
            </button>
          ) : (
            <button type="button" disabled className={PRIMARY_BUTTON}>
              提交
            </button>
          )}
        </div>

        {notice && (
          <p className="shrink-0 px-1 text-[11px] text-fg-faint">{notice}</p>
        )}

        {error && (
          <p className="shrink-0 rounded border border-danger-line bg-danger-bg px-2 py-1 text-[11px] whitespace-pre-wrap text-danger">
            {error}
          </p>
        )}

        <div className="min-h-0 flex-1 overflow-auto">
          {staged.length === 0 && unstaged.length === 0 && (
            <p className="px-1 py-1 text-[11px] text-fg-faint">没有未提交的更改</p>
          )}

          {staged.length > 0 && (
            <>
              <div className="flex items-center gap-1 px-1 pt-1 pb-0.5">
                <span className="min-w-0 flex-1 truncate text-[11px] text-fg-faint">
                  暂存的更改 ({staged.length})
                </span>
                {stagedDiscardable.length > 0 && (
                  <button
                    type="button"
                    onClick={discardAllStaged}
                    disabled={busy !== null}
                    title="放弃这个分组里所有文件的更改"
                    className={GROUP_ICON_DANGER}
                  >
                    <IconUndo className="h-3 w-3" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void run("unstage", () => gitUnstage())}
                  disabled={busy !== null}
                  title="全部取消暂存"
                  className={GROUP_ICON}
                >
                  <IconMinus className="h-3 w-3" />
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
                  onDiscard={(path) =>
                    discard([path], { mode: "staged" }, change.relative)
                  }
                />
              ))}
            </>
          )}

          {unstaged.length > 0 && (
            <>
              <div className="flex items-center gap-1 px-1 pt-1.5 pb-0.5">
                <span className="min-w-0 flex-1 truncate text-[11px] text-fg-faint">
                  更改 ({unstaged.length})
                </span>
                {unstagedDiscardable.length > 0 && (
                  <button
                    type="button"
                    onClick={discardAllUnstaged}
                    disabled={busy !== null}
                    title="放弃这个分组里所有文件的更改"
                    className={GROUP_ICON_DANGER}
                  >
                    <IconUndo className="h-3 w-3" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void run("stage", () => gitStage())}
                  disabled={busy !== null}
                  title="全部暂存"
                  className={GROUP_ICON}
                >
                  <IconPlus className="h-3 w-3" />
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
                  onDiscard={(path) =>
                    discard([path], { mode: "unstaged" }, change.relative)
                  }
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

      {/* 弹框用 fixed 定位，挂在这儿不会挤到面板布局（祖先里没有 transform） */}
      {pendingDiscard && (
        <ConfirmDialog
          message={`放弃 ${pendingDiscard.what} 的更改？将还原到${
            pendingDiscard.source.mode === "staged" ? "上次提交（HEAD）" : "暂存区"
          }的版本，无法撤销。`}
          confirmLabel="放弃"
          onConfirm={confirmDiscard}
          onCancel={() => setPendingDiscard(null)}
        />
      )}
    </div>
  );
}
