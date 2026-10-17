import { useCallback, useEffect, useMemo, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { folderName } from "../lib/workspaces";
import {
  isWorkstreamSnoozed,
  workstreamCreate,
  workstreamList,
  workstreamRemove,
  type ReviewTarget,
} from "../lib/workstreams";
import type { WorkstreamInfo } from "../lib/types";
import { ConfirmDialog } from "./ConfirmDialog";
import { IconBranch, IconChevronDown, IconChevronRight, IconMore, IconPlus, IconWorktree } from "./icons";

interface ChangeCenterPaneProps {
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
  onReview: (target: ReviewTarget) => void;
  /** 打开旧的完整 Git 面板（暂存 / 提交 / 时间线 / stash） */
  onOpenAdvanced: () => void;
}

// 工作树清单要逐棵跑 status，比单根轮询重；只在面板露在眼前时拉，15 秒一次。
// 切回窗口 / 手动刷新 / 合并后都会立刻补一次，不靠这个周期保证及时性。
const POLL_MS = 15000;

function relativeTime(seconds: number): string {
  if (!seconds) return "";
  const diff = Date.now() / 1000 - seconds;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;
  return new Date(seconds * 1000).toLocaleDateString();
}

type Tone = "danger" | "warn" | "ok" | "accent" | "muted";

const DOT: Record<Tone, string> = {
  danger: "bg-danger",
  warn: "bg-warn",
  ok: "bg-ok",
  accent: "bg-accent",
  muted: "bg-fg-faint",
};

const CHIP: Record<Tone, string> = {
  danger: "border-danger-line text-danger",
  warn: "border-warn-line text-warn",
  ok: "border-line-strong text-ok",
  accent: "border-accent-line text-accent",
  muted: "border-line-strong text-fg-dim",
};

interface StateInfo {
  label: string;
  tone: Tone;
  /** 排序用：越大越该被先看到 */
  weight: number;
}

/** 一条工作线此刻的状态。刻意不引入 agent 会话，先按 Git 事实说话。 */
function stateOf(item: WorkstreamInfo): StateInfo {
  if (item.prunable) return { label: "目录失联", tone: "danger", weight: 90 };
  if (item.conflicts > 0) return { label: "冲突", tone: "danger", weight: 100 };
  if (item.merging) return { label: "合并中", tone: "danger", weight: 95 };
  if (item.detached) return { label: "游离 HEAD", tone: "warn", weight: 70 };
  if (item.kind === "worktree" && item.changed > 0)
    return { label: "待审阅", tone: "warn", weight: 60 };
  if (item.kind === "worktree" && item.merged && item.changed === 0) {
    // 刚建出来、还没有独有提交的工作树也是 merged；它只是「干净」，
    // 不能显示成「已合并」、更不能进清理建议。
    if (item.head && item.baseHead && item.head === item.baseHead) {
      return { label: "干净", tone: "muted", weight: 10 };
    }
    return { label: "已合并", tone: "ok", weight: 20 };
  }
  if (item.ahead > 0) return { label: "待合并", tone: "accent", weight: 50 };
  if (item.locked) return { label: "锁定", tone: "muted", weight: 25 };
  return { label: "干净", tone: "muted", weight: 10 };
}

function attentionOf(item: WorkstreamInfo): StateInfo | null {
  const state = stateOf(item);
  // 「需要你」只收真正会挡住下一步的状态；可清理、未检出分支留给下面的分区
  if (state.weight < 50) return null;
  return state;
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
 * 变更中心总览：先回答「我现在在哪、什么需要我、还有哪些工作树」。
 *
 * 这里只做观察、审阅入口和少量生命周期操作，不切换编辑器 / 终端 / 文件树
 * 所在的上下文——工作树是后台的并行产物，不是第二个工作区。
 */
export function ChangeCenterPane({
  root,
  roots,
  visible,
  moduleVisible,
  reloadSignal,
  gitReady,
  onReview,
  onOpenAdvanced,
}: ChangeCenterPaneProps) {
  const [selectedRoot, setSelectedRoot] = useState(root);
  const [items, setItems] = useState<WorkstreamInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<WorkstreamInfo | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [branchesOpen, setBranchesOpen] = useState(false);
  const [cleanupOpen, setCleanupOpen] = useState(false);

  useEffect(() => {
    setSelectedRoot(root);
  }, [root]);

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

  const current = useMemo(
    () => items.find((item) => item.kind === "main") ?? items[0] ?? null,
    [items],
  );
  const base = current?.branch ?? "main";
  const worktrees = useMemo(
    () => items.filter((item) => item.kind === "worktree"),
    [items],
  );
  const branches = useMemo(
    () => items.filter((item) => item.kind === "branch"),
    [items],
  );
  // 不用 useMemo：snooze 存在 localStorage 里，关掉审阅工作台不会改变 items；
  // 每次渲染重算一遍（最多几十条），才能立刻把「稍后」的那条从注意力里拿掉。
  const attention = worktrees
    .filter((item) => !isWorkstreamSnoozed(selectedRoot, item.branch ?? item.name))
    .map((item) => ({ item, state: attentionOf(item) }))
    .filter((entry): entry is { item: WorkstreamInfo; state: StateInfo } =>
      Boolean(entry.state),
    )
    .sort((a, b) => b.state.weight - a.state.weight)
    .slice(0, 5);
  const cleanup = useMemo(
    () =>
      worktrees.filter(
        (item) =>
          item.merged &&
          item.changed === 0 &&
          item.head !== item.baseHead &&
          !item.locked &&
          !item.prunable,
      ),
    [worktrees],
  );

  const refresh = useCallback(async () => {
    try {
      const next = await workstreamList(selectedRoot);
      setItems(next);
      setError(null);
    } catch (reason) {
      setError(String(reason));
    }
  }, [selectedRoot]);

  const review = useCallback(
    (item: WorkstreamInfo) => {
      if (item.kind === "main") {
        onOpenAdvanced();
        return;
      }
      onReview(reviewTargetOf(selectedRoot, item, base));
    },
    [base, onOpenAdvanced, onReview, selectedRoot],
  );

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
      const state = stateOf(item);
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
    [base, copy],
  );

  const remove = useCallback(async () => {
    if (!pendingRemove) return;
    setBusy(true);
    try {
      const next = await workstreamRemove(selectedRoot, pendingRemove.path);
      setItems(next);
      setPendingRemove(null);
      setNotice("工作树已移除，分支保留");
    } catch (reason) {
      setError(String(reason));
      setPendingRemove(null);
    } finally {
      setBusy(false);
    }
  }, [pendingRemove, selectedRoot]);

  const create = useCallback(async () => {
    const name = createName.trim();
    if (!name) return;
    setBusy(true);
    try {
      const next = await workstreamCreate(selectedRoot, name, base);
      setItems(next);
      setCreateName("");
      setCreateOpen(false);
      setNotice(`已创建 ${name}`);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }, [base, createName, selectedRoot]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menu]);

  const keyOf = (item: WorkstreamInfo) => item.path || item.branch || item.name;

  const row = (item: WorkstreamInfo) => (
    <WorkstreamRow
      key={keyOf(item)}
      item={item}
      base={base}
      menuOpen={menu === keyOf(item)}
      onToggleMenu={() => setMenu((current) => (current === keyOf(item) ? null : keyOf(item)))}
      onReview={() => {
        setMenu(null);
        review(item);
      }}
      onCopy={(text) => void copy(text, "路径已复制")}
      onReveal={(path) => {
        setMenu(null);
        void revealItemInDir(path).catch(() => setNotice("无法打开文件管理器"));
      }}
      onSendBack={() => void sendBack(item)}
      onRemove={() => {
        setMenu(null);
        setPendingRemove(item);
      }}
    />
  );

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
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
          <div className="px-3 py-8 text-center">
            <p className="text-[12px] text-fg-dim">这个目录还不是 Git 仓库。</p>
            <button
              type="button"
              onClick={onOpenAdvanced}
              className="mt-2 rounded border border-line-strong px-2.5 py-1 text-[11px] text-fg-muted hover:bg-hover hover:text-fg"
            >
              打开高级 Git 初始化
            </button>
          </div>
        ) : (
          <>
            <div className="shrink-0 border-b border-line px-3 py-2">
              <div className="flex items-center gap-2">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT.muted}`} />
                <span className="text-[11px] font-medium tracking-wide text-fg-dim">当前检出</span>
                <span className="ml-auto min-w-0 truncate font-mono text-[11px] text-fg-muted">
                  {current?.branch ?? "未检出分支"}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 pl-3.5 text-[10px] text-fg-faint">
                <span className="min-w-0 truncate">{folderName(selectedRoot)}</span>
                <span>
                  ↑{current?.upstreamAhead ?? 0} ↓{current?.upstreamBehind ?? 0}
                </span>
                <span className={current?.changed ? "text-warn" : ""}>
                  {current?.changed ? `${current.changed} 处改动` : "干净"}
                </span>
                <button
                  type="button"
                  onClick={onOpenAdvanced}
                  className="ml-auto text-accent hover:underline"
                >
                  高级 Git
                </button>
              </div>
              {current?.lastCommitSubject && (
                <p className="mt-1 truncate pl-3.5 text-[10px] text-fg-faint">
                  {current.lastCommitSubject}
                </p>
              )}
            </div>

            <section className="shrink-0 border-b border-line">
              <div className="flex h-7 items-center gap-2 px-3">
                <span className="text-[11px] font-medium tracking-wide text-fg-dim">需要你</span>
                {attention.length > 0 && (
                  <span className="min-w-[14px] rounded-full bg-warn px-1 text-center text-[9px] leading-[14px] font-medium text-app tabular-nums">
                    {attention.length}
                  </span>
                )}
              </div>
              {attention.length === 0 ? (
                <p className="px-3 pb-2 text-[11px] text-fg-faint">没有需要你处理的事情。</p>
              ) : (
                <div className="pb-1">
                  {attention.map(({ item, state }) => (
                    <button
                      key={keyOf(item)}
                      type="button"
                      onClick={() => review(item)}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-hover"
                    >
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[state.tone]}`} />
                      <span className="min-w-0 flex-1 truncate text-[12px] text-fg">
                        {item.branch ?? item.name}
                      </span>
                      <span
                        className={`shrink-0 rounded border px-1 text-[10px] leading-4 ${CHIP[state.tone]}`}
                      >
                        {state.label}
                      </span>
                      <span className="shrink-0 text-[10px] text-fg-faint">
                        {relativeTime(item.lastCommitTime)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </section>

            <section className="shrink-0 border-b border-line">
              <div className="flex h-7 items-center gap-2 px-3">
                <IconWorktree className="h-3 w-3 shrink-0 text-fg-icon" />
                <span className="text-[11px] font-medium tracking-wide text-fg-dim">工作树</span>
                <span className="text-[10px] text-fg-faint">{worktrees.length}</span>
                <button
                  type="button"
                  onClick={() => setCreateOpen((open) => !open)}
                  className="ml-auto flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] text-fg-dim hover:bg-active hover:text-fg"
                >
                  <IconPlus className="h-3 w-3" />
                  新建
                </button>
              </div>

              {createOpen && (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void create();
                  }}
                  className="border-b border-line px-3 py-2"
                >
                  <input
                    autoFocus
                    value={createName}
                    onChange={(event) => setCreateName(event.target.value)}
                    placeholder="分支名，例如 agent/fix-login"
                    className="h-7 w-full rounded border border-line-strong bg-surface px-2 font-mono text-[11px] text-fg outline-none placeholder:text-fg-faint focus:border-accent"
                  />
                  <p className="mt-1 text-[10px] text-fg-faint">
                    在仓库同级创建 worktree，基准 {base}
                  </p>
                  <div className="mt-1.5 flex justify-end gap-1.5">
                    <button
                      type="button"
                      onClick={() => setCreateOpen(false)}
                      className="rounded border border-line-strong px-2 py-0.5 text-[10px] text-fg-muted hover:bg-hover hover:text-fg"
                    >
                      取消
                    </button>
                    <button
                      type="submit"
                      disabled={busy || !createName.trim()}
                      className="rounded border border-accent-line px-2 py-0.5 text-[10px] text-accent hover:bg-selected disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      创建
                    </button>
                  </div>
                </form>
              )}

              {loading && items.length === 0 ? (
                <p className="px-3 pb-2 text-[11px] text-fg-faint">正在读取工作树…</p>
              ) : worktrees.length === 0 ? (
                <p className="px-3 pb-2 text-[11px] text-fg-faint">
                  还没有额外的工作树。智能体在别处创建的 worktree 也会自动出现在这里。
                </p>
              ) : (
                worktrees.map(row)
              )}
            </section>

            {branches.length > 0 && (
              <section className="shrink-0 border-b border-line">
                <button
                  type="button"
                  onClick={() => setBranchesOpen((open) => !open)}
                  className="flex h-7 w-full items-center gap-1.5 px-3 text-left text-[11px] text-fg-dim hover:bg-hover"
                >
                  {branchesOpen ? (
                    <IconChevronDown className="h-3 w-3 shrink-0" />
                  ) : (
                    <IconChevronRight className="h-3 w-3 shrink-0" />
                  )}
                  <IconBranch className="h-3 w-3 shrink-0 text-fg-icon" />
                  <span>未检出分支</span>
                  <span className="text-[10px] text-fg-faint">{branches.length}</span>
                </button>
                {branchesOpen && branches.map(row)}
              </section>
            )}

            {cleanup.length > 0 && (
              <section className="shrink-0 border-b border-line">
                <button
                  type="button"
                  onClick={() => setCleanupOpen((open) => !open)}
                  className="flex h-7 w-full items-center gap-1.5 px-3 text-left text-[11px] text-fg-dim hover:bg-hover"
                >
                  {cleanupOpen ? (
                    <IconChevronDown className="h-3 w-3 shrink-0" />
                  ) : (
                    <IconChevronRight className="h-3 w-3 shrink-0" />
                  )}
                  <span>清理建议</span>
                  <span className="text-[10px] text-fg-faint">{cleanup.length} 个已合并工作树</span>
                </button>
                {cleanupOpen && (
                  <div className="pb-1">
                    {cleanup.map((item) => (
                      <div
                        key={keyOf(item)}
                        className="flex items-center gap-2 px-3 py-1.5 text-[11px]"
                      >
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ok" />
                        <span className="min-w-0 flex-1 truncate text-fg-muted">
                          {item.branch ?? item.name}
                        </span>
                        <button
                          type="button"
                          onClick={() => setPendingRemove(item)}
                          className="shrink-0 rounded border border-line-strong px-1.5 py-0.5 text-[10px] text-fg-dim hover:border-danger-line hover:text-danger"
                        >
                          移除
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}
          </>
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
    </>
  );
}

function WorkstreamRow({
  item,
  base,
  menuOpen,
  onToggleMenu,
  onReview,
  onCopy,
  onReveal,
  onSendBack,
  onRemove,
}: {
  item: WorkstreamInfo;
  base: string;
  menuOpen: boolean;
  onToggleMenu: () => void;
  onReview: () => void;
  onCopy: (text: string) => void;
  onReveal: (path: string) => void;
  onSendBack: () => void;
  onRemove: () => void;
}) {
  const state = stateOf(item);
  const secondary =
    item.kind === "worktree" ? folderName(item.path) : `基于 ${item.base ?? base}`;
  const removable =
    item.kind === "worktree" &&
    item.merged &&
    item.changed === 0 &&
    !item.locked &&
    !item.prunable;

  return (
    <div className="group relative border-b border-line/60 px-3 py-2 last:border-b-0 hover:bg-hover">
      <button
        type="button"
        onClick={onReview}
        className="flex w-full min-w-0 items-center gap-2 text-left"
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[state.tone]}`} />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-fg">
          {item.branch ?? item.name}
        </span>
        <span
          className={`shrink-0 rounded border px-1 text-[10px] leading-4 ${CHIP[state.tone]}`}
        >
          {state.label}
        </span>
      </button>
      <div className="mt-0.5 flex items-center gap-2 pl-3.5 text-[10px] text-fg-faint">
        <span className="min-w-0 truncate">{secondary}</span>
        {item.ahead > 0 && <span className="shrink-0 text-accent">↑{item.ahead}</span>}
        {item.behind > 0 && <span className="shrink-0 text-warn">↓{item.behind}</span>}
        {item.additions > 0 && <span className="shrink-0 text-ok">+{item.additions}</span>}
        {item.deletions > 0 && <span className="shrink-0 text-danger">-{item.deletions}</span>}
        {item.diffFiles > 0 && <span className="shrink-0">{item.diffFiles} 文件</span>}
        {item.changed > 0 && <span className="shrink-0 text-warn">{item.changed} 未提交</span>}
        <span className="ml-auto shrink-0">{relativeTime(item.lastCommitTime)}</span>
      </div>

      <button
        type="button"
        title="更多"
        onClick={(event) => {
          event.stopPropagation();
          onToggleMenu();
        }}
        className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded text-fg-faint opacity-0 hover:bg-active hover:text-fg group-hover:opacity-100"
      >
        <IconMore className="h-3.5 w-3.5" />
      </button>

      {menuOpen && (
        <div className="absolute right-2 top-8 z-20 w-40 rounded-md border border-line-strong bg-raised py-1 shadow-lg">
          <MenuItem label="审阅" onClick={onReview} />
          {item.path && <MenuItem label="复制路径" onClick={() => onCopy(item.path)} />}
          {item.path && (
            <MenuItem
              label="在文件管理器中显示"
              onClick={() => onReveal(item.path)}
            />
          )}
          <MenuItem label="复制反馈模板" onClick={onSendBack} />
          {removable && <MenuItem label="移除工作树" onClick={onRemove} danger />}
        </div>
      )}
    </div>
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
