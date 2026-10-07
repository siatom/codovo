import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  baseName,
  formatBytes,
  formatMtime,
  joinRemote,
  parentRemote,
  remoteCrumbs,
  sftpDownload,
  sftpHome,
  sftpList,
  sftpMkdir,
  sftpRemove,
  sftpRename,
  sftpUpload,
  type SftpEntry,
} from "../lib/remote";
import { ConfirmDialog } from "./ConfirmDialog";
import {
  IconArrowDownToLine,
  IconArrowUp,
  IconArrowUpFromLine,
  IconChevronRight,
  IconFile,
  IconFolder,
  IconFolderPlus,
  IconPencil,
  IconRefresh,
  IconTrash,
} from "./icons";

const HEAD_BUTTON =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-dim hover:bg-active hover:text-fg disabled:text-fg-faint disabled:hover:bg-transparent";

const ROW_INPUT =
  "h-6 w-full rounded border border-accent bg-surface px-1 text-[12px] text-fg outline-none";

interface Progress {
  label: string;
  transferred: number;
  total: number;
}

/**
 * 远程文件浏览（SFTP）。不是递归目录树——只在当前目录里列，用面包屑和「上一级」导航，
 * 这样一次只拉一屏、不用为整棵树付代价。
 */
export function RemoteFiles({ sessionId }: { sessionId: number }) {
  const [path, setPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<SftpEntry[]>([]);
  const [selected, setSelected] = useState<SftpEntry | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<Progress | null>(null);
  const [creating, setCreating] = useState(false);
  const [createDraft, setCreateDraft] = useState("");
  const [renaming, setRenaming] = useState<SftpEntry | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [pendingDelete, setPendingDelete] = useState<SftpEntry | null>(null);
  const createRef = useRef<HTMLInputElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);

  // 会话换了（换了台主机）就回到它的家目录
  useEffect(() => {
    let cancelled = false;
    setPath(null);
    setEntries([]);
    setSelected(null);
    setError("");
    void sftpHome(sessionId)
      .then((home) => {
        if (!cancelled) setPath(home);
      })
      .catch((reason) => {
        if (!cancelled) setError(String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const refresh = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try {
      const list = await sftpList(sessionId, path);
      setEntries(list);
      setError("");
      setSelected((current) =>
        current ? list.find((item) => item.path === current.path) ?? null : null,
      );
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLoading(false);
    }
  }, [path, sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const enter = (entry: SftpEntry) => {
    if (entry.isDir) {
      setPath(entry.path);
      setSelected(null);
    }
  };

  const upload = async () => {
    if (!path) return;
    try {
      const picked = await open({ multiple: false, title: "选择要上传的文件" });
      if (typeof picked !== "string") return;
      const name = baseName(picked);
      setProgress({ label: name, transferred: 0, total: 0 });
      await sftpUpload(sessionId, picked, joinRemote(path, name), (event) => {
        setProgress(event.done ? null : { label: name, transferred: event.transferred, total: event.total });
      });
      await refresh();
    } catch (reason) {
      setProgress(null);
      setError(String(reason));
    }
  };

  const download = async (entry: SftpEntry) => {
    try {
      const dest = await save({ defaultPath: entry.name, title: "保存到" });
      if (!dest) return;
      setProgress({ label: entry.name, transferred: 0, total: entry.size });
      await sftpDownload(sessionId, entry.path, dest, (event) => {
        setProgress(event.done ? null : { label: entry.name, transferred: event.transferred, total: event.total });
      });
    } catch (reason) {
      setProgress(null);
      setError(String(reason));
    }
  };

  const commitCreate = async () => {
    const name = createDraft.trim();
    setCreating(false);
    setCreateDraft("");
    if (!name || !path) return;
    try {
      await sftpMkdir(sessionId, joinRemote(path, name));
      await refresh();
    } catch (reason) {
      setError(String(reason));
    }
  };

  const commitRename = async () => {
    const target = renaming;
    const name = renameDraft.trim();
    setRenaming(null);
    if (!target || !name || name === target.name) return;
    const parent = parentRemote(target.path) ?? "/";
    try {
      await sftpRename(sessionId, target.path, joinRemote(parent, name));
      await refresh();
    } catch (reason) {
      setError(String(reason));
    }
  };

  const confirmDelete = async () => {
    const target = pendingDelete;
    setPendingDelete(null);
    if (!target) return;
    try {
      await sftpRemove(sessionId, target.path, target.isDir);
      setSelected(null);
      await refresh();
    } catch (reason) {
      setError(String(reason));
    }
  };

  const inputKey = (event: KeyboardEvent<HTMLInputElement>, commit: () => void) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      setCreating(false);
      setRenaming(null);
    }
  };

  const crumbs = path ? remoteCrumbs(path) : [];
  const up = path ? parentRemote(path) : null;
  const percent =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.transferred / progress.total) * 100))
      : null;

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-line px-2">
        <button
          type="button"
          disabled={!up}
          onClick={() => up && setPath(up)}
          title="上一级"
          className={HEAD_BUTTON}
        >
          <IconArrowUp className="h-3.5 w-3.5" />
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto whitespace-nowrap">
          {crumbs.map((crumb, index) => (
            <span key={crumb.path} className="flex shrink-0 items-center gap-0.5">
              {index > 0 && <IconChevronRight className="h-3 w-3 text-fg-faint" />}
              <button
                type="button"
                onClick={() => setPath(crumb.path)}
                className="rounded px-1 text-[11px] text-fg-dim hover:bg-hover hover:text-fg"
              >
                {crumb.name}
              </button>
            </span>
          ))}
        </div>
        <button type="button" onClick={() => void refresh()} title="刷新" className={HEAD_BUTTON}>
          <IconRefresh className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => {
            setCreateDraft("");
            setCreating(true);
            requestAnimationFrame(() => createRef.current?.focus());
          }}
          title="新建目录"
          className={HEAD_BUTTON}
        >
          <IconFolderPlus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => void upload()}
          disabled={!path}
          title="上传文件"
          className={HEAD_BUTTON}
        >
          <IconArrowUpFromLine className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => selected && !selected.isDir && void download(selected)}
          disabled={!selected || selected.isDir}
          title="下载到本地"
          className={HEAD_BUTTON}
        >
          <IconArrowDownToLine className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => {
            if (!selected) return;
            setRenameDraft(selected.name);
            setRenaming(selected);
            requestAnimationFrame(() => renameRef.current?.select());
          }}
          disabled={!selected}
          title="重命名"
          className={HEAD_BUTTON}
        >
          <IconPencil className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => selected && setPendingDelete(selected)}
          disabled={!selected}
          title="删除"
          className={HEAD_BUTTON}
        >
          <IconTrash className="h-3.5 w-3.5" />
        </button>
      </div>

      {error && (
        <div className="flex shrink-0 items-start gap-2 border-b border-danger-line bg-danger-bg px-2 py-1 text-[11px] text-danger">
          <span className="flex-1 break-all">{error}</span>
          <button
            type="button"
            onClick={() => setError("")}
            className="shrink-0 rounded px-1 hover:bg-hover"
          >
            关闭
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {creating && (
          <div className="flex items-center gap-2 px-2 py-1">
            <IconFolder className="h-3.5 w-3.5 shrink-0 text-fg-dim" />
            <input
              ref={createRef}
              value={createDraft}
              onChange={(event) => setCreateDraft(event.target.value)}
              onKeyDown={(event) => inputKey(event, () => void commitCreate())}
              onBlur={() => void commitCreate()}
              placeholder="新目录名"
              spellCheck={false}
              className={ROW_INPUT}
            />
          </div>
        )}

        {!path && !error && (
          <p className="px-3 py-4 text-[12px] text-fg-faint">正在定位远程主目录…</p>
        )}
        {path && entries.length === 0 && !loading && !creating && (
          <p className="px-3 py-4 text-[12px] text-fg-faint">空目录</p>
        )}

        {entries.map((entry) => {
          const isRenaming = renaming?.path === entry.path;
          const isSelected = selected?.path === entry.path;
          return (
            <div
              key={entry.path}
              onClick={() => setSelected(entry)}
              onDoubleClick={() => (entry.isDir ? enter(entry) : void download(entry))}
              title={entry.path}
              className={`flex h-6 cursor-default items-center gap-2 px-2 text-[12px] ${
                isSelected ? "bg-selected text-fg" : "text-fg-muted hover:bg-hover"
              }`}
            >
              {entry.isDir ? (
                <IconFolder className="h-3.5 w-3.5 shrink-0 text-fg-dim" />
              ) : (
                <IconFile className="h-3.5 w-3.5 shrink-0 text-fg-dim" />
              )}
              {isRenaming ? (
                <input
                  ref={renameRef}
                  value={renameDraft}
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => setRenameDraft(event.target.value)}
                  onKeyDown={(event) => inputKey(event, () => void commitRename())}
                  onBlur={() => void commitRename()}
                  spellCheck={false}
                  className={ROW_INPUT}
                />
              ) : (
                <>
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                  <span className="shrink-0 text-[11px] text-fg-faint tabular-nums">
                    {entry.isDir ? "" : formatBytes(entry.size)}
                  </span>
                  <span className="w-[120px] shrink-0 text-right text-[11px] text-fg-faint tabular-nums">
                    {formatMtime(entry.mtime)}
                  </span>
                </>
              )}
            </div>
          );
        })}
      </div>

      {progress && (
        <div className="shrink-0 border-t border-line px-3 py-1.5">
          <div className="flex items-center justify-between text-[11px] text-fg-dim">
            <span className="truncate">{progress.label}</span>
            <span className="tabular-nums">
              {percent === null
                ? formatBytes(progress.transferred)
                : `${percent}% · ${formatBytes(progress.transferred)}`}
            </span>
          </div>
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-active">
            <div
              className="h-full rounded-full bg-accent transition-[width]"
              style={{ width: percent === null ? "30%" : `${percent}%` }}
            />
          </div>
        </div>
      )}

      {pendingDelete && (
        <ConfirmDialog
          message={`删除远程${pendingDelete.isDir ? "目录" : "文件"}「${pendingDelete.name}」？此操作不可撤销。`}
          confirmLabel="删除"
          onConfirm={() => void confirmDelete()}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </section>
  );
}
