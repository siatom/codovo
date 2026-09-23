import { useCallback, useMemo, useState, type KeyboardEvent } from "react";
import { gitCommit, gitStage, gitUnstage, pathKey, toDisplayPath } from "../lib/fs";
import {
  isStaged,
  isUnstaged,
  markOfColumn,
  type GitChange,
  type GitController,
} from "../lib/git";
import type { GitStatusPayload } from "../lib/types";
import { GitMarkBadge } from "./GitMarkBadge";
import { FullscreenButton } from "./FullscreenButton";
import { IconBranch, IconMinus, IconPlus, IconRefresh } from "./icons";

interface GitChangesPaneProps {
  git: GitController;
  /** 点改动项：打开这个文件的差异视图（staged 决定跟 HEAD 还是跟 index 比） */
  onOpen: (path: string, staged: boolean) => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
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
  onOpen: (path: string, staged: boolean) => void;
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
        onClick={() => onOpen(change.path, staged)}
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
 * 改动列表 + 提交框，右栏「变更」模块的整屏内容。
 * 目录不是仓库（或系统里没有 git）时整个不渲染——工具列表那边已经把这行置灰了，
 * 这里的早退只是兜底。
 */
export function GitChangesPane({
  git,
  onOpen,
  fullscreen,
  onToggleFullscreen,
}: GitChangesPaneProps) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);

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
      return payload;
    });
  }, [message, run]);

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
    <div className="flex h-full min-h-0 flex-col">
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
          onClick={refresh}
          title="刷新"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-dim hover:bg-active hover:text-fg"
        >
          <IconRefresh className="h-3.5 w-3.5" />
        </button>
        <FullscreenButton fullscreen={fullscreen} onToggle={onToggleFullscreen} />
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
    </div>
  );
}
