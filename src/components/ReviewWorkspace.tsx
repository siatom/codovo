import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { gitFileHunks } from "../lib/fs";
import {
  isReviewed,
  setReviewed,
  snoozeWorkstream,
  workstreamFileHunks,
  workstreamMerge,
  workstreamReview,
  type ReviewTarget,
} from "../lib/workstreams";
import type { FileHunks, ReviewFile, WorkstreamReview } from "../lib/types";
import { ConfirmDialog } from "./ConfirmDialog";
import {
  IconArrowLeftToLine,
  IconCheck,
  IconClose,
  IconMerge,
  IconSend,
} from "./icons";

interface ReviewWorkspaceProps {
  target: ReviewTarget;
  onClose: () => void;
  /** 合并成功：上层可以刷新总览 */
  onMerged: () => void;
}

function relativeTime(seconds: number): string {
  if (!seconds) return "";
  const diff = Date.now() / 1000 - seconds;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;
  return new Date(seconds * 1000).toLocaleDateString();
}

function statusTone(status: string): string {
  if (status === "A" || status === "?") return "text-ok";
  if (status === "D") return "text-danger";
  if (status === "R" || status === "C") return "text-accent";
  return "text-warn";
}

function revisionOf(review: WorkstreamReview, file: ReviewFile): string {
  if (!file.dirty) return review.head ?? "";
  return `${review.head ?? "dirty"}:${file.status}:${file.additions}:${file.deletions}`;
}

interface DiffLine {
  oldLine: number | null;
  newLine: number | null;
  sign: " " | "+" | "-" | "\\";
  text: string;
}

/** 把一段 hunk 拆成带两侧行号的显示行。 */
function diffLinesOf(hunk: string): DiffLine[] {
  const lines = hunk.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const header = lines.shift() ?? "";
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(header);
  let oldLine = match ? Number(match[1]) : 0;
  let newLine = match ? Number(match[2]) : 0;
  const out: DiffLine[] = [];
  for (const line of lines) {
    const sign = line[0];
    if (sign === "+") {
      out.push({ oldLine: null, newLine, sign: "+", text: line.slice(1) });
      newLine += 1;
    } else if (sign === "-") {
      out.push({ oldLine, newLine: null, sign: "-", text: line.slice(1) });
      oldLine += 1;
    } else if (sign === "\\") {
      out.push({ oldLine: null, newLine: null, sign: "\\", text: line.slice(1) });
    } else {
      out.push({ oldLine, newLine, sign: " ", text: line.slice(1) });
      oldLine += 1;
      newLine += 1;
    }
  }
  return out;
}

/**
 * 审阅工作台：以一条工作线为单位看 diff、勾选已审、把反馈复制回智能体。
 *
 * 全宽覆盖在主界面上，但**不改变**下面的编辑器 / 终端状态；关闭后原样露出。
 * 所有操作只读或显式生命周期操作（合并 / 移除），不在这里编辑工作树里的文件。
 */
export function ReviewWorkspace({ target, onClose, onMerged }: ReviewWorkspaceProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [review, setReview] = useState<WorkstreamReview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReviewFile | null>(null);
  const [hunks, setHunks] = useState<FileHunks | null>(null);
  const [hunksLoading, setHunksLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const [onlyUnreviewed, setOnlyUnreviewed] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [confirmMerge, setConfirmMerge] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 3500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // 审阅盖在终端 / 编辑器上面：挂载时把焦点接过来，避免打开后按键还落到后面的终端。
  // 只做一次——跟着 feedbackOpen / confirmMerge 重跑会把弹框里 textarea 的焦点抢走。
  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  // Esc 关闭，但反馈框 / 合并确认框开着时交给它们自己处理。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !feedbackOpen && !confirmMerge) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, feedbackOpen, confirmMerge]);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError(null);
    setReview(null);
    setSelected(null);
    workstreamReview(target.root, target.path, target.branch, target.base)
      .then((next) => {
        if (disposed) return;
        setReview(next);
        setSelected(next.files[0] ?? next.dirtyFiles[0] ?? null);
      })
      .catch((reason) => {
        if (!disposed) setError(String(reason));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [target.root, target.path, target.branch, target.base]);

  useEffect(() => {
    if (!selected || !review) {
      setHunks(null);
      return;
    }
    let disposed = false;
    setHunksLoading(true);
    setHunks(null);
    const request = selected.dirty
      ? target.path
        ? gitFileHunks(target.path, selected.path, selected.staged)
        : Promise.resolve(null)
      : review.baseSha && review.head
        ? workstreamFileHunks(
            target.root,
            target.path,
            selected.relative,
            review.baseSha,
            review.head,
          )
        : Promise.resolve(null);
    request
      .then((next) => {
        if (!disposed) setHunks(next);
      })
      .catch((reason) => {
        if (!disposed) setError(String(reason));
      })
      .finally(() => {
        if (!disposed) setHunksLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [selected, review, target.path, target.root]);

  const files = useMemo(
    () => (review ? [...review.files, ...review.dirtyFiles] : []),
    [review],
  );
  const reviewedSet = useMemo(() => {
    const out = new Set<string>();
    if (!review) return out;
    for (const file of files) {
      if (isReviewed(target.root, target.branch, file.relative, revisionOf(review, file))) {
        out.add(file.relative);
      }
    }
    return out;
  }, [files, review, target.root, target.branch, tick]);

  const toggleReviewed = useCallback(
    (file: ReviewFile) => {
      if (!review) return;
      const revision = revisionOf(review, file);
      const done = isReviewed(target.root, target.branch, file.relative, revision);
      setReviewed(
        target.root,
        target.branch,
        file.relative,
        done ? null : revision,
      );
      setTick((value) => value + 1);
    },
    [review, target.root, target.branch],
  );

  const markAll = useCallback(() => {
    if (!review) return;
    for (const file of files) {
      setReviewed(
        target.root,
        target.branch,
        file.relative,
        revisionOf(review, file),
      );
    }
    setTick((value) => value + 1);
  }, [files, review, target.root, target.branch]);

  const visibleFiles = useMemo(
    () =>
      onlyUnreviewed
        ? files.filter((file) => !reviewedSet.has(file.relative))
        : files,
    [files, onlyUnreviewed, reviewedSet],
  );

  const committedVisible = visibleFiles.filter((file) => !file.dirty);
  const dirtyVisible = visibleFiles.filter((file) => file.dirty);

  const merge = useCallback(async () => {
    if (!review) return;
    setBusy(true);
    setError(null);
    try {
      await workstreamMerge(target.root, review.branch, review.base);
      setConfirmMerge(false);
      setNotice("已合并，正在刷新总览…");
      onMerged();
      window.setTimeout(onClose, 400);
    } catch (reason) {
      setError(String(reason));
      setConfirmMerge(false);
    } finally {
      setBusy(false);
    }
  }, [onClose, onMerged, review, target.root]);

  const promptText = useCallback(() => {
    if (!review) return "";
    const fileLines = files.slice(0, 40).map((file) => {
      const done = reviewedSet.has(file.relative);
      return `- ${file.relative}（${done ? "已审" : "未审"}） +${file.additions} / -${file.deletions}`;
    });
    return [
      `请继续处理工作树 ${target.path ?? target.name}。`,
      `分支：${review.branch}，基准：${review.base}${
        review.baseSha ? `（${review.baseSha.slice(0, 7)}）` : ""
      }`,
      `已提交改动：${review.commits.length} 个提交，${review.files.length} 个文件，+${review.additions} / -${review.deletions}`,
      review.dirtyFiles.length > 0
        ? `未提交改动：${review.dirtyFiles.length} 个文件`
        : "",
      "",
      "审阅范围：",
      ...fileLines,
      "",
      "反馈：",
      feedback.trim() || "（请补充反馈）",
    ]
      .filter(Boolean)
      .join("\n");
  }, [feedback, files, review, reviewedSet, target.name, target.path]);

  const copyFeedback = useCallback(async () => {
    try {
      await writeText(promptText());
      setFeedbackOpen(false);
      setNotice("反馈已复制到剪贴板");
    } catch {
      setError("复制失败，请检查剪贴板权限");
    }
  }, [promptText]);

  const snooze = useCallback(() => {
    snoozeWorkstream(target.root, target.branch);
    onClose();
  }, [onClose, target.branch, target.root]);

  const selectedChecked = selected ? reviewedSet.has(selected.relative) : false;
  const reviewedCount = reviewedSet.size;
  const canMerge =
    Boolean(review) &&
    target.kind !== "main" &&
    (review?.commits.length ?? 0) > 0;

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className="absolute inset-0 z-30 flex min-h-0 min-w-0 flex-col bg-app outline-none"
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-content px-3">
        <button
          type="button"
          onClick={onClose}
          className="flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-[11px] text-fg-dim hover:bg-hover hover:text-fg"
        >
          <IconArrowLeftToLine className="h-3.5 w-3.5" />
          变更中心
        </button>
        <div className="h-4 w-px shrink-0 bg-line" />
        <span className="min-w-0 max-w-[280px] truncate text-[13px] font-medium text-fg">
          {review?.detached ? "游离 HEAD" : review?.branch ?? target.name}
        </span>
        <span className="shrink-0 rounded border border-line-strong px-1.5 py-0.5 text-[10px] text-fg-dim">
          {target.kind === "branch" ? "未检出分支" : "工作树"}
        </span>
        <span className="min-w-0 truncate font-mono text-[11px] text-fg-dim">
          {target.branch} → {target.base}
        </span>
        {review && (
          <span className="shrink-0 text-[11px] text-fg-faint tabular-nums">
            {review.commits.length} 提交 · {files.length} 文件
            <span className="ml-1 text-ok">+{review.additions}</span>
            <span className="ml-1 text-danger">-{review.deletions}</span>
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {review && (
            <span className="text-[10px] text-fg-faint tabular-nums">
              已审 {reviewedCount}/{files.length}
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            title="关闭审阅"
            className="flex h-6 w-6 items-center justify-center rounded text-fg-dim hover:bg-hover hover:text-fg"
          >
            <IconClose className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-56 shrink-0 flex-col border-r border-line bg-content">
          <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-2">
            <span className="text-[11px] font-medium text-fg-dim">审阅地图</span>
            <label className="ml-auto flex cursor-pointer items-center gap-1 text-[10px] text-fg-faint">
              <input
                type="checkbox"
                checked={onlyUnreviewed}
                onChange={(event) => setOnlyUnreviewed(event.target.checked)}
                className="accent-accent"
              />
              只看未审
            </label>
          </div>
          <div className="min-h-0 flex-1 overflow-auto py-1">
            {committedVisible.length > 0 && (
              <p className="px-2 py-1 text-[10px] font-medium tracking-wide text-fg-faint">
                已提交 · {committedVisible.length}
              </p>
            )}
            {committedVisible.map((file) => (
              <ReviewFileRow
                key={`c:${file.relative}`}
                file={file}
                selected={selected?.relative === file.relative && !selected.dirty}
                reviewed={reviewedSet.has(file.relative)}
                onSelect={() => setSelected(file)}
                onToggle={() => toggleReviewed(file)}
              />
            ))}
            {dirtyVisible.length > 0 && (
              <p className="px-2 py-1 text-[10px] font-medium tracking-wide text-fg-faint">
                未提交 · {dirtyVisible.length}
              </p>
            )}
            {dirtyVisible.map((file) => (
              <ReviewFileRow
                key={`d:${file.relative}`}
                file={file}
                selected={selected?.relative === file.relative && selected.dirty}
                reviewed={reviewedSet.has(file.relative)}
                onSelect={() => setSelected(file)}
                onToggle={() => toggleReviewed(file)}
              />
            ))}
            {!loading && visibleFiles.length === 0 && (
              <p className="px-2 py-3 text-[11px] text-fg-faint">
                {files.length === 0 ? "这条工作线没有改动。" : "全部文件都已审阅。"}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={markAll}
            disabled={files.length === 0}
            className="m-2 flex shrink-0 items-center justify-center gap-1 rounded border border-line-strong px-2 py-1 text-[10px] text-fg-dim hover:bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
          >
            <IconCheck className="h-3 w-3" />
            全部标记已审
          </button>
        </aside>

        <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface">
          {loading ? (
            <div className="flex flex-1 items-center justify-center text-[12px] text-fg-faint">
              正在读取审阅数据…
            </div>
          ) : error && !review ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
              <p className="text-[12px] text-danger">{error}</p>
              <button
                type="button"
                onClick={onClose}
                className="rounded border border-line-strong px-2 py-1 text-[11px] text-fg-muted hover:bg-hover"
              >
                返回变更中心
              </button>
            </div>
          ) : selected ? (
            <>
              <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-3">
                <span className={`font-mono text-[11px] ${statusTone(selected.status)}`}>
                  {selected.status}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg">
                  {selected.relative}
                </span>
                <span className="shrink-0 text-[10px] text-ok">+{selected.additions}</span>
                <span className="shrink-0 text-[10px] text-danger">-{selected.deletions}</span>
                <button
                  type="button"
                  onClick={() => toggleReviewed(selected)}
                  className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${
                    selectedChecked
                      ? "border-accent-line bg-selected text-accent"
                      : "border-line-strong text-fg-dim hover:bg-hover hover:text-fg"
                  }`}
                >
                  {selectedChecked ? "已审" : "标记已审"}
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                {hunksLoading ? (
                  <p className="p-3 text-[11px] text-fg-faint">正在读取 diff…</p>
                ) : hunks && hunks.hunks.length > 0 ? (
                  hunks.hunks.map((hunk, index) => (
                    <div key={index} className="border-b border-line">
                      <div className="flex items-center gap-2 bg-content px-3 py-1 font-mono text-[10px] text-fg-dim">
                        <span className="min-w-0 flex-1 truncate" title={hunk.header}>
                          {hunk.header}
                        </span>
                        <span className="shrink-0 text-ok">+{hunk.added}</span>
                        <span className="shrink-0 text-danger">-{hunk.removed}</span>
                      </div>
                      <div className="min-w-max py-1 font-mono text-[11px] leading-[18px]">
                        {diffLinesOf(hunk.text).map((line, lineIndex) => (
                          <div
                            key={lineIndex}
                            className={`flex whitespace-pre ${
                              line.sign === "+"
                                ? "bg-ok/10"
                                : line.sign === "-"
                                  ? "bg-danger-bg"
                                  : ""
                            }`}
                          >
                            <span className="w-10 shrink-0 select-none pr-1 text-right text-fg-faint">
                              {line.oldLine ?? ""}
                            </span>
                            <span className="w-10 shrink-0 select-none pr-1 text-right text-fg-faint">
                              {line.newLine ?? ""}
                            </span>
                            <span
                              className={`w-4 shrink-0 select-none text-center ${
                                line.sign === "+"
                                  ? "text-ok"
                                  : line.sign === "-"
                                    ? "text-danger"
                                    : "text-fg-faint"
                              }`}
                            >
                              {line.sign === " " ? "" : line.sign}
                            </span>
                            <span
                              className={`pr-4 ${
                                line.sign === "\\" ? "text-fg-faint" : "text-fg"
                              }`}
                            >
                              {line.text}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="p-3 text-[11px] text-fg-faint">
                    {hunks ? "这个文件没有可逐块显示的改动（新增 / 删除 / 二进制）。" : "读不到这个文件的 diff。"}
                  </p>
                )}
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center text-[12px] text-fg-faint">
              从左边选择一个文件开始审阅。
            </div>
          )}
        </main>

        <aside className="hidden w-60 shrink-0 flex-col border-l border-line bg-content lg:flex">
          <div className="border-b border-line px-3 py-2">
            <p className="text-[10px] font-medium tracking-wide text-fg-faint">基准</p>
            <p className="mt-1 truncate font-mono text-[11px] text-fg">
              {review?.base ?? target.base}
              {review?.baseSha ? ` @ ${review.baseSha.slice(0, 7)}` : ""}
            </p>
            <p className="mt-2 text-[10px] font-medium tracking-wide text-fg-faint">HEAD</p>
            <p className="mt-1 truncate font-mono text-[11px] text-fg">
              {review?.head?.slice(0, 7) ?? target.head?.slice(0, 7) ?? "—"}
            </p>
            {review && review.dirtyFiles.length > 0 && (
              <p className="mt-2 text-[10px] text-warn">
                另有 {review.dirtyFiles.length} 个未提交文件
              </p>
            )}
          </div>
          <div className="border-b border-line px-3 py-2 text-[10px] text-fg-faint">
            <p>检查：未配置</p>
            <p className="mt-0.5">智能体会话：未关联</p>
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
            <p className="text-[10px] font-medium tracking-wide text-fg-faint">
              提交 · {review?.commits.length ?? 0}
            </p>
            <div className="mt-1 space-y-1.5">
              {(review?.commits ?? []).map((commit) => (
                <div key={commit.hash} className="min-w-0">
                  <div className="flex items-baseline gap-1.5">
                    <span className="shrink-0 font-mono text-[10px] text-accent">
                      {commit.short}
                    </span>
                    <span className="shrink-0 text-[9px] text-fg-faint">
                      {relativeTime(commit.time)}
                    </span>
                  </div>
                  <p className="mt-0.5 break-words text-[11px] leading-snug text-fg-muted">
                    {commit.subject}
                  </p>
                </div>
              ))}
              {review && review.commits.length === 0 && (
                <p className="text-[10px] text-fg-faint">
                  没有已提交改动；只审未提交部分。
                </p>
              )}
            </div>
          </div>
        </aside>
      </div>

      <footer className="flex h-10 shrink-0 items-center gap-2 border-t border-line bg-content px-3">
        <span className="shrink-0 text-[10px] text-fg-faint tabular-nums">
          已审 {reviewedCount}/{files.length}
        </span>
        {error && review && (
          <span className="min-w-0 flex-1 truncate text-[10px] text-danger" title={error}>
            {error}
          </span>
        )}
        {notice && !error && (
          <span className="min-w-0 flex-1 truncate text-[10px] text-ok">{notice}</span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => setFeedbackOpen(true)}
            className="flex items-center gap-1 rounded border border-line-strong px-2 py-1 text-[11px] text-fg-muted hover:bg-hover hover:text-fg"
          >
            <IconSend className="h-3 w-3" />
            请求修改
          </button>
          <button
            type="button"
            onClick={snooze}
            className="rounded border border-line-strong px-2 py-1 text-[11px] text-fg-muted hover:bg-hover hover:text-fg"
          >
            稍后
          </button>
          <button
            type="button"
            onClick={() => setConfirmMerge(true)}
            disabled={!canMerge || busy}
            title={canMerge ? "把这条工作线合并进基准分支" : "没有可合并的已提交改动"}
            className="flex items-center gap-1 rounded border border-accent-line bg-selected px-2.5 py-1 text-[11px] text-accent hover:bg-active disabled:cursor-not-allowed disabled:opacity-40"
          >
            <IconMerge className="h-3 w-3" />
            合并
          </button>
        </div>
      </footer>

      {feedbackOpen && (
        <div
          className="absolute inset-0 z-40 flex items-center justify-center bg-black/40 p-6"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setFeedbackOpen(false);
          }}
        >
          <div className="w-[560px] max-w-full rounded-xl border border-line-strong bg-raised p-4 shadow-lg">
            <h3 className="text-[13px] font-medium text-fg">请求修改</h3>
            <p className="mt-1 text-[11px] leading-relaxed text-fg-dim">
              反馈会连同分支、改动范围和文件清单复制到剪贴板，粘贴回对应的智能体会话即可。
            </p>
            <textarea
              autoFocus
              value={feedback}
              onChange={(event) => setFeedback(event.target.value)}
              placeholder="例如：登录失败时没有清除旧 token；补一个回归测试。"
              className="mt-3 h-28 w-full resize-none rounded border border-line-strong bg-surface px-2 py-1.5 text-[12px] leading-relaxed text-fg outline-none placeholder:text-fg-faint focus:border-accent"
            />
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setFeedbackOpen(false)}
                className="rounded border border-line-strong px-2.5 py-1 text-[11px] text-fg-muted hover:bg-hover hover:text-fg"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void copyFeedback()}
                className="rounded border border-accent-line bg-selected px-2.5 py-1 text-[11px] text-accent hover:bg-active"
              >
                复制反馈
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmMerge && review && (
        <ConfirmDialog
          message={`把 ${review.branch} 合并进 ${review.base}？主工作区必须干净；合并后这条工作树会显示为已合并。`}
          confirmLabel="合并"
          onConfirm={() => void merge()}
          onCancel={() => setConfirmMerge(false)}
        />
      )}
    </div>
  );
}

function ReviewFileRow({
  file,
  selected,
  reviewed,
  onSelect,
  onToggle,
}: {
  file: ReviewFile;
  selected: boolean;
  reviewed: boolean;
  onSelect: () => void;
  onToggle: () => void;
}) {
  return (
    <div
      className={`flex items-center gap-1.5 px-2 py-1 ${
        selected ? "bg-selected" : "hover:bg-hover"
      }`}
    >
      <input
        type="checkbox"
        checked={reviewed}
        onChange={onToggle}
        title={reviewed ? "标记为未审" : "标记已审"}
        className="shrink-0 accent-accent"
      />
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
      >
        <span className={`shrink-0 font-mono text-[10px] ${statusTone(file.status)}`}>
          {file.status}
        </span>
        <span
          className={`min-w-0 flex-1 truncate text-[11px] ${
            reviewed ? "text-fg-faint line-through" : "text-fg-muted"
          }`}
          title={file.relative}
        >
          {file.relative}
        </span>
        {file.dirty && (
          <span className="shrink-0 rounded border border-warn-line px-1 text-[9px] leading-4 text-warn">
            未提交
          </span>
        )}
      </button>
      <div className="flex shrink-0 items-center gap-1 text-[9px] tabular-nums">
        {file.additions > 0 && <span className="text-ok">+{file.additions}</span>}
        {file.deletions > 0 && <span className="text-danger">-{file.deletions}</span>}
      </div>
    </div>
  );
}
