import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { pathKey } from "../lib/fs";
import { folderName } from "../lib/workspaces";
import type { GitController } from "../lib/git";
import type { DiffSource } from "../lib/tabs";
import type {
  ReviewFile,
  TerminalSessionInfo,
  WorkstreamInfo,
  WorkstreamReview,
} from "../lib/types";
import {
  workstreamList,
  workstreamMerge,
  workstreamRemove,
  workstreamReview,
  type ReviewTarget,
} from "../lib/workstreams";
import { workstreamState, type WorkstreamState } from "../lib/workstream-state";
import { ConfirmDialog } from "./ConfirmDialog";
import {
  IconArrowLeftToLine,
  IconBranch,
  IconMerge,
  IconMore,
  IconTerminal,
  IconWorktree,
} from "./icons";

interface ChangesRadarPaneProps {
  /** 工作区活动根（主检出）；所有 git 命令都以它为仓库边界 */
  root: string;
  /** 工作区里的全部根，多根时给一个切换入口 */
  roots: string[];
  /** 工作区是否可见 */
  visible: boolean;
  /** 「变更」模块是否真的露在用户眼前 */
  moduleVisible: boolean;
  /** 标题栏刷新信号 */
  reloadSignal: number;
  /** 目录是不是 git 仓库；false 时给空状态 */
  gitReady: boolean;
  /** 各根的 git 控制器（2 秒轮询），比 workstream_list 新 */
  gitByRoot: Record<string, GitController>;
  /** 根 -> 「变更」面板实际看的目标（被选中的 worktree） */
  gitTargets: Record<string, string>;
  /** 终端会话归属：判断哪个工作树在跑、谁在等用户 */
  sessions: readonly TerminalSessionInfo[];
  /** 打开一个文件的差异视图 */
  onOpenDiff: (path: string, source: DiffSource) => void;
  /** 切到某个目录的终端（没有就新开一个） */
  onOpenTerminal: (cwd: string) => void;
  /** 打开全宽审阅工作台 */
  onReview: (target: ReviewTarget) => void;
  /** 打开完整 Git 面板（暂存 / 提交 / 时间线） */
  onOpenAdvanced: () => void;
}

/** 雷达顶部的两个列表。默认停在「工作树」——那是 Agent 编程时真正要盯的一层 */
type ListTab = "worktree" | "branch";

// 工作树清单要逐棵跑 status，比单根轮询重；只在面板露在眼前时拉，15 秒一次。
// 切回窗口 / 手动刷新 / 写完操作都会立刻补一次，不靠这个周期保证及时性。
const POLL_MS = 15000;

/** 还没轮询到的根用的空控制器：只读、什么都不做 */
const EMPTY_CONTROLLER: GitController = {
  snapshot: {
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
  },
  refresh: () => {},
  applyStatus: () => {},
};

function relativeTime(seconds: number): string {
  if (!seconds) return "";
  const diff = Date.now() / 1000 - seconds;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;
  return new Date(seconds * 1000).toLocaleDateString();
}

const DOT: Record<WorkstreamState["tone"], string> = {
  danger: "bg-danger",
  warn: "bg-warn",
  accent: "bg-accent",
  ok: "bg-ok",
  muted: "bg-fg-faint",
};

const CHIP: Record<WorkstreamState["tone"], string> = {
  danger: "border-danger-line text-danger",
  warn: "border-warn-line text-warn",
  accent: "border-accent-line text-accent",
  ok: "border-line-strong text-ok",
  muted: "border-line-strong text-fg-dim",
};

/** 会话的 cwd 是不是落在这条工作线里。分支没有目录，永远不匹配 */
function sessionsIn(
  sessions: readonly TerminalSessionInfo[],
  path: string,
): readonly TerminalSessionInfo[] {
  if (!path) return [];
  const key = pathKey(path);
  return sessions.filter((item) => pathKey(item.cwd) === key);
}

function signalsOf(
  sessions: readonly TerminalSessionInfo[],
  path: string,
): { terminals: number; waiting: boolean } {
  const own = sessionsIn(sessions, path);
  return {
    terminals: own.length,
    waiting: own.some((item) => item.attention !== null),
  };
}

function reviewTargetOf(root: string, item: WorkstreamInfo, base: string): ReviewTarget {
  return {
    root,
    path: item.kind === "branch" ? null : item.path,
    // 游离 HEAD 没有分支名；用 HEAD 作为审阅目标，避免把目录名当成分支
    branch: item.branch ?? (item.detached ? "HEAD" : item.name),
    base: item.base ?? base,
    baseSha: item.baseSha,
    head: item.head,
    name: item.branch ?? item.name,
    kind: item.kind,
  };
}

/**
 * 「变更」模块的主视图：仓库状态雷达。
 *
 * 面向以 Agent 编程为主的用法：大多数时候只需要看清「主检出什么状态、每棵工作树
 * 上有没有人在跑、谁在等我、哪棵可以收掉」，所以这里只读、按「要不要我管」排序、
 * 行内不常驻按钮。真正要改历史 / 暂存 / 提交时才进完整 Git 面板。
 *
 * 顶部两个列表回答两个不同的问题：
 * - 工作树：这台机器上现在有哪些检出（含 main / master 本身），各自改了什么、谁在跑；
 * - 分支：仓库里有哪些本地分支，谁被检出、检出在哪，相对基准还差多少提交。
 * 点任一行进入面板内的详情（提交历史 + 改动文件），点文件打开差异标签；
 * 行尾主按钮切到那棵树上的终端。刻意不做分支检出，保持「面板不抢终端上下文」。
 */
export function ChangesRadarPane({
  root,
  roots,
  visible,
  moduleVisible,
  reloadSignal,
  gitReady,
  gitByRoot,
  gitTargets,
  sessions,
  onOpenDiff,
  onOpenTerminal,
  onReview,
  onOpenAdvanced,
}: ChangesRadarPaneProps) {
  const [selectedRoot, setSelectedRoot] = useState(root);
  const [tab, setTab] = useState<ListTab>("worktree");
  const [items, setItems] = useState<WorkstreamInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [detail, setDetail] = useState<WorkstreamInfo | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = useState<WorkstreamInfo | null>(null);
  const [pendingMerge, setPendingMerge] = useState<WorkstreamInfo | null>(null);
  // 这一根还没轮询到时的占位控制器：读出来是「不是仓库」，不会误显示别的仓库状态
  const git = gitByRoot[gitTargets[selectedRoot] ?? selectedRoot] ?? EMPTY_CONTROLLER;
  // 主检出自己的快照（2 秒轮询）。选了别的 worktree 当目标、或者还没轮询到时没有，
  // 那时退回 workstream_list 的数据，不能拿空快照把主检出覆盖成「干净」
  const liveSnapshot = gitByRoot[selectedRoot]?.snapshot ?? null;
  const liveMain = liveSnapshot?.isRepo ? liveSnapshot : null;

  useEffect(() => {
    setSelectedRoot(root);
  }, [root]);

  // 换根时退出详情：详情里的 git 命令都以旧根为边界，留着会指错仓库
  useEffect(() => {
    setDetail(null);
    setMenu(null);
  }, [selectedRoot]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 3500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!visible || !moduleVisible) return;
    let disposed = false;
    let inFlight = false;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await workstreamList(selectedRoot);
        if (!disposed) {
          setItems(next);
          setError(null);
        }
      } catch (reason) {
        if (!disposed) setError(String(reason));
      } finally {
        inFlight = false;
        if (!disposed) setLoading(false);
      }
    };
    setLoading(true);
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [selectedRoot, visible, moduleVisible, reloadSignal]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menu]);

  const refresh = useCallback(async () => {
    try {
      const next = await workstreamList(selectedRoot);
      setItems(next);
      setError(null);
    } catch (reason) {
      setError(String(reason));
    }
  }, [selectedRoot]);

  const current = useMemo(
    () => items.find((item) => item.kind === "main") ?? items[0] ?? null,
    [items],
  );
  const base = current?.branch ?? "main";
  const worktrees = useMemo(() => items.filter((item) => item.kind !== "branch"), [items]);
  const branches = useMemo(() => items.filter((item) => item.kind === "branch"), [items]);

  /** 分支名 -> 检出它的工作树。分支页据此回答「这条分支有没有被检出、检出在哪」 */
  const checkedOutBy = useMemo(() => {
    const out = new Map<string, WorkstreamInfo>();
    for (const item of worktrees) {
      if (item.branch) out.set(item.branch, item);
    }
    return out;
  }, [worktrees]);

  /**
   * 排序用的一份条目：把状态算一次，列表和角标共用。
   * 主检出用 `git.snapshot` 的实时值覆盖 workstream_list 的旧值——它是 2 秒轮询。
   */
  const ranked = useMemo(() => {
    return worktrees
      .map((item) => {
        const merged =
          item.kind === "main" && liveMain
            ? {
                ...item,
                branch: liveMain.branch ?? item.branch,
                head: liveMain.head ?? item.head,
                changed: liveMain.changed,
                conflicts: liveMain.conflicts,
                merging: liveMain.merging,
              }
            : item;
        return {
          item: merged,
          state: workstreamState(merged, signalsOf(sessions, merged.path)),
        };
      })
      .sort(
        (a, b) =>
          b.state.weight - a.state.weight ||
          // 同权重时主检出排在别的树前面：它是「你现在在哪」的锚点
          (a.item.kind === "main" ? -1 : b.item.kind === "main" ? 1 : 0) ||
          b.item.lastCommitTime - a.item.lastCommitTime,
      );
  }, [liveMain, sessions, worktrees]);

  const branchRows = useMemo(() => {
    return branches
      .map((item) => ({ item, state: workstreamState(item) }))
      .sort(
        (a, b) =>
          b.state.weight - a.state.weight || b.item.lastCommitTime - a.item.lastCommitTime,
      );
  }, [branches]);

  const waitingCount = ranked.filter((entry) => entry.state.needsYou).length;

  const copy = useCallback(async (text: string, message: string) => {
    try {
      await writeText(text);
      setNotice(message);
    } catch {
      setNotice("复制失败");
    }
  }, []);

  const sendBack = useCallback(
    async (item: WorkstreamInfo) => {
      const state = workstreamState(item, signalsOf(sessions, item.path));
      const prompt = [
        `请继续处理工作树 ${item.path || item.branch || item.name}。`,
        `分支：${item.branch ?? "(游离 HEAD)"}，基准：${item.base ?? base}`,
        `当前状态：${state.label}；已提交改动 ${item.diffFiles} 个文件，+${item.additions} / -${item.deletions}。`,
        item.changed > 0 ? `另有 ${item.changed} 处未提交改动。` : "",
        "",
        "请先阅读当前工作树里的改动，然后按下面的反馈调整：",
        "（在这里补充反馈）",
      ]
        .filter(Boolean)
        .join("\n");
      await copy(prompt, "已复制反馈模板");
      setMenu(null);
    },
    [base, copy, sessions],
  );

  const remove = useCallback(async () => {
    if (!pendingRemove) return;
    try {
      const next = await workstreamRemove(selectedRoot, pendingRemove.path);
      setItems(next);
      setPendingRemove(null);
      setNotice("工作树已移除，分支保留");
    } catch (reason) {
      setError(String(reason));
      setPendingRemove(null);
    }
  }, [pendingRemove, selectedRoot]);

  const merge = useCallback(async () => {
    if (!pendingMerge) return;
    try {
      await workstreamMerge(selectedRoot, pendingMerge.branch ?? pendingMerge.name, pendingMerge.base ?? base);
      await refresh();
      git.refresh();
      setPendingMerge(null);
      setNotice("已合并进基准分支");
    } catch (reason) {
      setError(String(reason));
      setPendingMerge(null);
    }
  }, [base, git, pendingMerge, refresh, selectedRoot]);

  const keyOf = (item: WorkstreamInfo) => item.path || item.branch || item.name;

  /** 分支被某棵工作树检出时，详情 / 审阅都落到那棵树上，才看得到未提交改动 */
  const dirOf = (item: WorkstreamInfo) =>
    item.path || (item.branch ? (checkedOutBy.get(item.branch)?.path ?? "") : "");

  const openDetail = (item: WorkstreamInfo) => {
    setMenu(null);
    setDetail(item);
  };

  if (detail) {
    // 详情跟着轮询走：agent 还在写的时候，列表会 15 秒刷一次，详情不该停在旧快照上
    const fresh = items.find((item) => keyOf(item) === keyOf(detail)) ?? detail;
    // 分支若已被检出，完整审阅按那棵工作树的目标打开（能带上未提交改动）
    const reviewItem =
      fresh.kind === "branch"
        ? (fresh.branch ? (checkedOutBy.get(fresh.branch) ?? fresh) : fresh)
        : fresh;
    return (
      <WorkstreamDetail
        root={selectedRoot}
        item={fresh}
        dir={dirOf(fresh)}
        base={base}
        sessions={sessions}
        onBack={() => setDetail(null)}
        onOpenDiff={onOpenDiff}
        onOpenTerminal={onOpenTerminal}
        onReview={() => onReview(reviewTargetOf(selectedRoot, reviewItem, base))}
        onAdvanced={onOpenAdvanced}
      />
    );
  }

  return (
    <>
      {roots.length > 1 && (
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5">
          <span className="text-[10px] text-fg-faint">仓库</span>
          <select
            value={selectedRoot}
            onChange={(event) => setSelectedRoot(event.target.value)}
            className="min-w-0 flex-1 rounded border border-line bg-surface px-1.5 py-1 text-[11px] text-fg outline-none focus:border-accent"
          >
            {roots.map((item) => (
              <option key={item} value={item}>
                {folderName(item)}
              </option>
            ))}
          </select>
        </div>
      )}

      {!gitReady ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-3 py-8 text-center">
          <p className="text-[12px] text-fg-dim">这个目录还不是 Git 仓库。</p>
          <button
            type="button"
            onClick={onOpenAdvanced}
            className="mt-2 rounded border border-line-strong px-2.5 py-1 text-[11px] text-fg-muted hover:bg-hover hover:text-fg"
          >
            打开完整 Git
          </button>
        </div>
      ) : (
        <>
          {/* 两个列表回答两个不同的问题：这里有哪些检出 / 这里有哪些分支。
              默认停在「工作树」，分支列表是一级入口，不再藏在折叠行里 */}
          <div className="flex shrink-0 items-center border-b border-line px-2 py-1.5">
            <div className="flex min-w-0 flex-1 items-center gap-0.5 rounded-md border border-line bg-surface p-0.5">
              <TabButton
                active={tab === "worktree"}
                icon={<IconWorktree className="h-3 w-3 shrink-0" />}
                label="工作树"
                count={ranked.length}
                alert={waitingCount}
                onClick={() => setTab("worktree")}
              />
              <TabButton
                active={tab === "branch"}
                icon={<IconBranch className="h-3 w-3 shrink-0" />}
                label="分支"
                count={branchRows.length}
                alert={0}
                onClick={() => setTab("branch")}
              />
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col overflow-auto">
            {tab === "worktree" ? (
              ranked.length === 0 ? (
                <p className="px-3 py-3 text-[11px] text-fg-faint">
                  {loading
                    ? "正在读取工作树…"
                    : "还没有检出。智能体在别处创建的 worktree 也会自动出现在这里。"}
                </p>
              ) : (
                <ul className="flex flex-col py-1">
                  {ranked.map(({ item, state }) => (
                    <li key={keyOf(item)}>
                      <WorktreeRow
                        item={item}
                        state={state}
                        terminals={signalsOf(sessions, item.path).terminals}
                        menuOpen={menu === keyOf(item)}
                        onOpen={() => openDetail(item)}
                        onTerminal={() => onOpenTerminal(item.path)}
                        onToggleMenu={() =>
                          setMenu((current) => (current === keyOf(item) ? null : keyOf(item)))
                        }
                        onCopy={(text) => void copy(text, "路径已复制")}
                        onReveal={(path) => {
                          setMenu(null);
                          void revealItemInDir(path).catch(() => setNotice("无法打开文件管理器"));
                        }}
                        onSendBack={() => void sendBack(item)}
                        onMerge={() => {
                          setMenu(null);
                          setPendingMerge(item);
                        }}
                        onRemove={() => {
                          setMenu(null);
                          setPendingRemove(item);
                        }}
                      />
                    </li>
                  ))}
                </ul>
              )
            ) : branchRows.length === 0 ? (
              <p className="px-3 py-3 text-[11px] text-fg-faint">
                {loading ? "正在读取分支…" : "这个仓库还没有本地分支。"}
              </p>
            ) : (
              <ul className="flex flex-col py-1">
                {branchRows.map(({ item, state }) => (
                  <li key={keyOf(item)}>
                    <BranchRow
                      item={item}
                      state={state}
                      checkedOut={item.branch ? checkedOutBy.get(item.branch) : undefined}
                      onOpen={() => openDetail(item)}
                    />
                  </li>
                ))}
              </ul>
            )}

            {error && (
              <div className="mt-auto flex shrink-0 items-start gap-2 border-t border-danger-line bg-danger-bg px-3 py-2 text-[10px] leading-relaxed text-danger">
                <span className="min-w-0 flex-1 break-words">{error}</span>
                <button
                  type="button"
                  onClick={() => void refresh()}
                  className="shrink-0 underline hover:no-underline"
                >
                  重试
                </button>
              </div>
            )}
            {notice && !error && (
              <div className="mt-auto shrink-0 border-t border-line px-3 py-1.5 text-[10px] text-fg-dim">
                {notice}
              </div>
            )}
          </div>
        </>
      )}

      {pendingRemove && (
        <ConfirmDialog
          message={`移除工作树「${folderName(pendingRemove.path)}」？分支 ${
            pendingRemove.branch ?? pendingRemove.name
          } 会保留；工作树里有未提交改动时后端会拒绝。被忽略的本地文件（node_modules、.env 等）会随目录一起删除。`}
          confirmLabel="移除"
          onConfirm={() => void remove()}
          onCancel={() => setPendingRemove(null)}
        />
      )}
      {pendingMerge && (
        <ConfirmDialog
          message={`把「${pendingMerge.branch ?? pendingMerge.name}」合并进 ${base}？主检出有未提交改动时后端会拒绝。`}
          confirmLabel="合并"
          onConfirm={() => void merge()}
          onCancel={() => setPendingMerge(null)}
        />
      )}
    </>
  );
}

/** 顶部分段按钮：图标 + 名字 + 条数，有需要你处理的行时再挂一个实心角标 */
function TabButton({
  active,
  icon,
  label,
  count,
  alert,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  count: number;
  alert: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex min-w-0 flex-1 items-center justify-center gap-1 rounded px-2 py-[3px] text-[11px] ${
        active ? "bg-active text-fg" : "text-fg-dim hover:text-fg"
      }`}
    >
      {icon}
      <span className="truncate">{label}</span>
      <span
        className={`shrink-0 text-[10px] tabular-nums ${active ? "text-fg-muted" : "text-fg-faint"}`}
      >
        {count}
      </span>
      {alert > 0 && (
        <span className="shrink-0 rounded-full bg-warn px-1 text-[9px] leading-[14px] font-medium text-app tabular-nums">
          {alert}
        </span>
      )}
    </button>
  );
}

/**
 * 工作树一行。两行排布而不是挤一行：右栏通常只有两三百像素宽，分支名、目录、
 * 改动规模、终端数全塞一行会各自被截断，反而看不出哪棵该管。
 *
 * 常驻只有一个「终端」按钮（这是唯一的高频动作：去看看 agent 干到哪了）；
 * ⋯ 菜单悬停才出现，装的是低频操作。
 */
function WorktreeRow({
  item,
  state,
  terminals,
  menuOpen,
  onOpen,
  onTerminal,
  onToggleMenu,
  onCopy,
  onReveal,
  onSendBack,
  onMerge,
  onRemove,
}: {
  item: WorkstreamInfo;
  state: WorkstreamState;
  /** cwd 落在这棵树里的终端数 */
  terminals: number;
  menuOpen: boolean;
  onOpen: () => void;
  onTerminal: () => void;
  onToggleMenu: () => void;
  onCopy: (text: string) => void;
  onReveal: (path: string) => void;
  onSendBack: () => void;
  onMerge: () => void;
  onRemove: () => void;
}) {
  const branch = item.detached ? "游离 HEAD" : (item.branch ?? item.name);
  // 有独有提交、且工作区干净，才值得给「合并」入口；脏的时候合了也带不走未提交内容。
  // 主检出自己就是合并的落点，不给自己合并自己。
  const mergeable =
    item.kind === "worktree" &&
    item.ahead > 0 &&
    item.changed === 0 &&
    !item.prunable &&
    item.exists;
  const removable =
    item.kind === "worktree" && item.merged && item.changed === 0 && !item.locked && !item.prunable;

  return (
    <div className="group relative px-2 py-1.5 hover:bg-hover">
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full min-w-0 items-center gap-1.5 pr-10 text-left"
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[state.tone]}`} />
        <span className="min-w-0 flex-1 truncate text-[12px] text-fg">{branch}</span>
        {item.kind === "main" && (
          <span className="shrink-0 rounded border border-line-strong px-1 text-[9px] leading-4 text-fg-faint">
            主检出
          </span>
        )}
        <span className={`shrink-0 rounded border px-1 text-[10px] leading-4 ${CHIP[state.tone]}`}>
          {state.label}
        </span>
      </button>
      <div className="mt-0.5 flex min-w-0 items-center gap-1.5 pr-10 pl-3 text-[10px] text-fg-faint">
        <span className="min-w-0 truncate">{folderName(item.path)}</span>
        {terminals > 0 && (
          <span className="shrink-0 text-accent" title={`${terminals} 个终端落在这个目录`}>
            {terminals} 终端
          </span>
        )}
        {item.additions > 0 && <span className="shrink-0 text-ok">+{item.additions}</span>}
        {item.deletions > 0 && <span className="shrink-0 text-danger">-{item.deletions}</span>}
        {item.diffFiles > 0 && <span className="shrink-0">{item.diffFiles} 文件</span>}
        {item.ahead > 0 && <span className="shrink-0 text-accent">↑{item.ahead}</span>}
        {item.behind > 0 && <span className="shrink-0">↓{item.behind}</span>}
        <span className="ml-auto shrink-0">{relativeTime(item.lastCommitTime)}</span>
      </div>

      {/* 常驻的「去看」：切到那棵树上的终端；没有就新开一个 */}
      <div className="absolute right-1.5 top-1 flex items-center gap-0.5">
        <button
          type="button"
          title="在这个工作树里打开终端"
          onClick={(event) => {
            event.stopPropagation();
            onTerminal();
          }}
          className="flex h-5 w-5 items-center justify-center rounded text-fg-faint hover:bg-active hover:text-fg"
        >
          <IconTerminal className="h-3 w-3" />
        </button>
        <button
          type="button"
          title="更多"
          onClick={(event) => {
            event.stopPropagation();
            onToggleMenu();
          }}
          className="flex h-5 w-5 items-center justify-center rounded text-fg-faint opacity-0 hover:bg-active hover:text-fg group-hover:opacity-100"
        >
          <IconMore className="h-3 w-3" />
        </button>
      </div>

      {menuOpen && (
        <div className="absolute right-2 top-8 z-20 w-44 rounded-md border border-line-strong bg-raised py-1 shadow-lg">
          <MenuItem label="复制路径" onClick={() => onCopy(item.path)} />
          <MenuItem label="在文件管理器中显示" onClick={() => onReveal(item.path)} />
          <MenuItem label="复制反馈模板" onClick={onSendBack} />
          {mergeable && <MenuItem label={`合并进 ${item.base ?? "基准分支"}`} onClick={onMerge} />}
          {removable && <MenuItem label="移除工作树" onClick={onRemove} danger />}
        </div>
      )}
    </div>
  );
}

/**
 * 分支行：只回答「这条分支在哪、还差多少」。
 *
 * 检出状态放第二行开头——第一行已经有状态标签，再塞一个「已检出」两个都看不清；
 * 第二行本来就短，放得下目录名。
 */
function BranchRow({
  item,
  state,
  checkedOut,
  onOpen,
}: {
  item: WorkstreamInfo;
  state: WorkstreamState;
  /** 检出这条分支的工作树；未检出时为空 */
  checkedOut: WorkstreamInfo | undefined;
  onOpen: () => void;
}) {
  const branch = item.branch ?? item.name;
  // 基准分支和自己是零差异，说「已合并」是假话，单独标成基准
  const isBase = item.base === branch;
  const tone: WorkstreamState["tone"] = isBase ? "muted" : state.tone;
  const label = isBase ? "基准" : state.label;

  return (
    <button
      type="button"
      onClick={onOpen}
      className="block w-full px-2 py-1.5 text-left hover:bg-hover"
    >
      {/* 按钮里只放行内元素：button 的内容模型是 phrasing content，塞 div 是非法结构 */}
      <span className="flex min-w-0 items-center gap-1.5">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[tone]}`} />
        <span className="min-w-0 flex-1 truncate text-[12px] text-fg">{branch}</span>
        <span className={`shrink-0 rounded border px-1 text-[10px] leading-4 ${CHIP[tone]}`}>
          {label}
        </span>
      </span>
      <span className="mt-0.5 flex min-w-0 items-center gap-1.5 pl-3 text-[10px] text-fg-faint">
        {checkedOut ? (
          <span className="flex min-w-0 items-center gap-1">
            <span className="shrink-0 text-accent">已检出</span>
            <span className="min-w-0 truncate">
              {checkedOut.kind === "main" ? "主检出" : folderName(checkedOut.path)}
            </span>
          </span>
        ) : (
          <span className="shrink-0">未检出</span>
        )}
        {item.additions > 0 && <span className="shrink-0 text-ok">+{item.additions}</span>}
        {item.deletions > 0 && <span className="shrink-0 text-danger">-{item.deletions}</span>}
        {item.diffFiles > 0 && <span className="shrink-0">{item.diffFiles} 文件</span>}
        {item.ahead > 0 && <span className="shrink-0 text-accent">↑{item.ahead}</span>}
        {item.behind > 0 && <span className="shrink-0">↓{item.behind}</span>}
        <span className="ml-auto shrink-0">{relativeTime(item.lastCommitTime)}</span>
      </span>
    </button>
  );
}

function MenuItem({
  label,
  onClick,
  danger = false,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`block w-full px-2.5 py-1 text-left text-[11px] hover:bg-hover ${
        danger ? "text-danger" : "text-fg-muted hover:text-fg"
      }`}
    >
      {label}
    </button>
  );
}

/** 文件状态字母的颜色。和完整 Git 面板里的标记同一套语义 */
function statusTone(status: string): string {
  if (status === "A" || status === "?") return "text-ok";
  if (status === "D") return "text-danger";
  if (status === "R" || status === "C") return "text-accent";
  return "text-warn";
}

function SectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex h-7 items-center gap-2 px-3 text-[11px] font-medium tracking-wide text-fg-dim">
      <span>{label}</span>
      <span className="text-[10px] font-normal text-fg-faint tabular-nums">{count}</span>
    </div>
  );
}

/**
 * 一条工作线的详情：右栏内的一屏，不是全宽审阅工作台。
 *
 * 只回答「它改了什么、提交了哪些」：提交历史在前（agent 一轮干完最该看的是它写了
 * 什么），未提交的文件其次（那是下一轮的半成品），已提交的文件最后。
 * 点文件直接在编辑器里开差异标签，不在这里内嵌 diff——右栏宽度放不下两侧代码。
 *
 * 工作树和分支共用这一个视图：分支没被检出时 `dir` 为空，改动从仓库根上读，
 * 差异标签也落到仓库根（没有工作区就没有未提交那一节）。
 */
function WorkstreamDetail({
  root,
  item,
  dir,
  base,
  sessions,
  onBack,
  onOpenDiff,
  onOpenTerminal,
  onReview,
  onAdvanced,
}: {
  root: string;
  item: WorkstreamInfo;
  /** 读改动 / 开差异的目录：工作树路径，或分支被检出时的那棵树；未检出分支为空 */
  dir: string;
  base: string;
  sessions: readonly TerminalSessionInfo[];
  onBack: () => void;
  onOpenDiff: (path: string, source: DiffSource) => void;
  onOpenTerminal: (cwd: string) => void;
  onReview: () => void;
  onAdvanced: () => void;
}) {
  const [review, setReview] = useState<WorkstreamReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const signals = signalsOf(sessions, dir);
  const state = workstreamState(item, signals);
  const branch = item.detached ? "HEAD" : (item.branch ?? item.name);
  const kindLabel = item.kind === "main" ? "主检出" : item.kind === "branch" ? "分支" : "工作树";
  // 基准分支和自己零差异，说「已合并」是假话；和分支列表同一套说法
  const isBaseBranch = item.kind === "branch" && item.base === branch;
  const tone: WorkstreamState["tone"] = isBaseBranch ? "muted" : state.tone;
  const stateLabel = isBaseBranch ? "基准" : state.label;

  // item 每次轮询都是新对象：agent 还在写的时候详情要跟着刷新，不能停在旧快照上
  useEffect(() => {
    let disposed = false;
    setReview(null);
    setError(null);
    workstreamReview(root, dir || null, branch, item.base ?? base)
      .then((next) => {
        if (!disposed) setReview(next);
      })
      .catch((reason) => {
        if (!disposed) setError(String(reason));
      });
    return () => {
      disposed = true;
    };
  }, [base, branch, dir, item, item.base, root]);

  /** 未提交文件跟 index 比；已提交文件跟基准比。两侧都要有提交号才能开 range */
  const openFile = (file: ReviewFile) => {
    if (file.dirty) {
      if (!dir) return;
      onOpenDiff(file.path, { mode: "unstaged", root: dir });
      return;
    }
    if (!review?.baseSha || !review.head) return;
    onOpenDiff(file.path, {
      mode: "range",
      from: review.baseSha,
      to: review.head,
      root: dir || undefined,
    });
  };

  const fileRow = (file: ReviewFile) => (
    <li key={`${file.dirty ? "d" : "c"}:${file.relative}`}>
      <button
        type="button"
        onClick={() => openFile(file)}
        className="flex w-full min-w-0 items-center gap-1.5 px-2 py-0.5 text-left hover:bg-hover"
      >
        <span className={`w-3 shrink-0 font-mono text-[10px] ${statusTone(file.status)}`}>
          {file.status}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-fg-muted">{file.relative}</span>
        {file.additions > 0 && <span className="shrink-0 text-[10px] text-ok">+{file.additions}</span>}
        {file.deletions > 0 && (
          <span className="shrink-0 text-[10px] text-danger">-{file.deletions}</span>
        )}
      </button>
    </li>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <div className="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1.5">
        <button
          type="button"
          onClick={onBack}
          title="返回列表"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-dim hover:bg-active hover:text-fg"
        >
          <IconArrowLeftToLine className="h-3.5 w-3.5" />
        </button>
        <span className="min-w-0 flex-1 truncate text-[12px] text-fg">
          {item.detached ? "游离 HEAD" : (item.branch ?? item.name)}
        </span>
        <span className="shrink-0 rounded border border-line-strong px-1 text-[9px] leading-4 text-fg-faint">
          {kindLabel}
        </span>
        <span className={`shrink-0 rounded border px-1 text-[10px] leading-4 ${CHIP[tone]}`}>
          {stateLabel}
        </span>
        {dir && (
          <button
            type="button"
            onClick={() => onOpenTerminal(dir)}
            title="在这个工作树里打开终端"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-faint hover:bg-active hover:text-fg"
          >
            <IconTerminal className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <div className="shrink-0 border-b border-line px-3 py-2 text-[10px] text-fg-faint">
        <div className="flex items-center gap-2">
          <span className="min-w-0 truncate">{dir ? folderName(dir) : "未检出"}</span>
          {signals.terminals > 0 && (
            <span className="shrink-0 text-accent">{signals.terminals} 终端</span>
          )}
          <span className="ml-auto shrink-0">对比 {item.base ?? base}</span>
        </div>
        <div className="mt-0.5 flex items-center gap-2">
          {review ? (
            <>
              <span>{review.commits.length} 提交</span>
              <span>{review.files.length} 文件</span>
              {review.additions > 0 && <span className="text-ok">+{review.additions}</span>}
              {review.deletions > 0 && <span className="text-danger">-{review.deletions}</span>}
              {review.dirtyFiles.length > 0 && (
                <span className="text-warn">{review.dirtyFiles.length} 未提交</span>
              )}
            </>
          ) : (
            <span>正在读取改动…</span>
          )}
        </div>
      </div>

      {error ? (
        <p className="px-3 py-3 text-[11px] leading-relaxed text-danger">{error}</p>
      ) : review ? (
        <>
          <section className="shrink-0 border-b border-line">
            <SectionHeader label="提交历史" count={review.commits.length} />
            {review.commits.length === 0 ? (
              <p className="px-3 pb-2 text-[11px] text-fg-faint">
                {isBaseBranch ? "这是基准分支本身，没有相对自己的提交。" : "相对基准还没有提交。"}
              </p>
            ) : (
              <ul className="pb-1">
                {review.commits.map((commit) => (
                  <li
                    key={commit.hash}
                    title={`${commit.author} · ${new Date(commit.time * 1000).toLocaleString()}`}
                    className="flex min-w-0 items-baseline gap-1.5 px-3 py-0.5"
                  >
                    <span className="shrink-0 font-mono text-[10px] text-accent">
                      {commit.short}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[11px] text-fg-muted">
                      {commit.subject}
                    </span>
                    <span className="shrink-0 text-[10px] text-fg-faint">
                      {relativeTime(commit.time)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {review.dirtyFiles.length > 0 && (
            <section className="shrink-0 border-b border-line">
              <SectionHeader label="未提交" count={review.dirtyFiles.length} />
              <ul className="pb-1">{review.dirtyFiles.map(fileRow)}</ul>
            </section>
          )}

          <section className="shrink-0">
            <SectionHeader label="已提交" count={review.files.length} />
            {review.files.length === 0 ? (
              <p className="px-3 pb-2 text-[11px] text-fg-faint">相对基准还没有文件改动。</p>
            ) : (
              <ul className="pb-1">{review.files.map(fileRow)}</ul>
            )}
          </section>
        </>
      ) : null}

      <div className="mt-auto flex shrink-0 items-center gap-1.5 border-t border-line px-2 py-1.5">
        <button
          type="button"
          onClick={onReview}
          className="flex items-center gap-1 rounded border border-line-strong px-2 py-0.5 text-[10px] text-fg-muted hover:bg-hover hover:text-fg"
        >
          <IconMerge className="h-3 w-3" />
          完整审阅
        </button>
        <button
          type="button"
          onClick={onAdvanced}
          className="ml-auto text-[10px] text-fg-faint hover:text-fg"
        >
          完整 Git
        </button>
      </div>
    </div>
  );
}
