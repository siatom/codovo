import {
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { formatBytes, formatMtime } from "../lib/remote";
import { ConfirmDialog } from "./ConfirmDialog";
import { FileTypeIcon, FolderTypeIcon } from "./fileIcons";
import {
  IconArrowLeftToLine,
  IconArrowRightToLine,
  IconArrowUp,
  IconChevronRight,
  IconFolder,
  IconFolderPlus,
  IconMore,
  IconPencil,
  IconRefresh,
  IconTrash,
} from "./icons";

const HEAD_BUTTON =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-dim hover:bg-active hover:text-fg disabled:text-fg-faint disabled:hover:bg-transparent";

const ROW_INPUT =
  "h-6 w-full rounded border border-accent bg-surface px-1 text-[12px] text-fg outline-none";

const MENU_ITEM =
  "flex w-full items-center rounded px-2 py-1 text-left text-[12px] text-fg-muted hover:bg-hover hover:text-fg disabled:text-fg-faint disabled:hover:bg-transparent";

const MENU_W = 140;

/**
 * 正在拖拽的那一行。用模块级变量而不是只靠 `dataTransfer`：`dragover` 阶段读不到
 * data（浏览器只在 `drop` 时才给），而落点判断与高亮必须在 dragover 里就做出来。
 * 载荷本来就是同一个窗口内的拖拽，模块变量足够；它也顺便把外部拖进来的文件
 * （资源管理器等）挡在外面——那些拖拽不会经过这里的 `onDragStart`。
 */
let dragging: { entry: PanelEntry; side: "left" | "right" } | null = null;

/**
 * 拖拽时给 `dataTransfer` 带的私有类型。用自定义 MIME 而不是 `text/plain`：
 * 一是让 Chromium 认为载荷非空、不会取消这次拖拽；二是别把路径当成文本拖到
 * 终端 / 编辑器里，那会变成一次意外的粘贴。
 */
const DRAG_MIME = "application/x-codovo-entry";

/** 面板里的一行。远程是 SftpEntry、本地是 LocalEntry，两者同构 */
export interface PanelEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  mtime: number;
}

export interface PanelProgress {
  label: string;
  transferred: number;
  total: number;
}

export interface FilePanelProps {
  /** 「本地」/「远程」 */
  label: string;
  icon: ReactNode;
  /** 面板在左还是右，决定「传到对侧」箭头的方向 */
  side: "left" | "right";
  path: string | null;
  crumbs: { name: string; path: string }[];
  entries: PanelEntry[];
  selected: PanelEntry | null;
  loading: boolean;
  /** 数据加载错误（父维护）。行内操作错误由本组件自己维护 */
  error: string;
  progress: PanelProgress | null;
  canUp: boolean;
  onUp: () => void;
  onNavigate: (path: string) => void;
  onSelect: (entry: PanelEntry) => void;
  /** 双击一行：目录进下一层、文件传给对侧（由容器决定语义） */
  onActivate: (entry: PanelEntry) => void;
  onRefresh: () => void;
  onMkdir: (name: string) => Promise<void>;
  onRename: (entry: PanelEntry, name: string) => Promise<void>;
  onDelete: (entry: PanelEntry) => Promise<void>;
  onTransfer: (entry: PanelEntry) => void;
  onDismissError: () => void;
  /**
   * 把一行拖到对侧面板时调用。`targetDir` 是落点目录（落到目录行 = 该目录，
   * 落到空白 = 对侧当前目录）；`side` 是**起点面板**在哪一侧。
   */
  onDropEntry: (entry: PanelEntry, targetDir: string, side: "left" | "right") => void;
  /** 本面板当前目录的绝对路径；null 表示还没定位好，此时不接受拖入 */
  dropDir: string | null;
}

/**
 * 双文件面板里的一个面板（本地 / 远程各实例化一次）。
 *
 * 只管展示和行内交互，数据与传输都交给容器——这样本地（fs 命令）和远程（SFTP）
 * 能共用同一套界面。工具栏分两行：上行是面板标识 + 传输 + 更多菜单（刷新 / 新建目录 /
 * 重命名 / 删除），下行是上一级 + 面包屑。右栏里的每个面板只有一两百像素宽，
 * 挤在一行会放不下。
 */
export function FilePanel({
  label,
  icon,
  side,
  path,
  crumbs,
  entries,
  selected,
  loading,
  error,
  progress,
  canUp,
  onUp,
  onNavigate,
  onSelect,
  onActivate,
  onRefresh,
  onMkdir,
  onRename,
  onDelete,
  onTransfer,
  onDismissError,
  onDropEntry,
  dropDir,
}: FilePanelProps) {
  const [creating, setCreating] = useState(false);
  const [createDraft, setCreateDraft] = useState("");
  const [renaming, setRenaming] = useState<PanelEntry | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [pendingDelete, setPendingDelete] = useState<PanelEntry | null>(null);
  const [actionError, setActionError] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  /** 拖拽落点高亮：正在拖入的目录行（空串表示落在空白 = 当前目录） */
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const createRef = useRef<HTMLInputElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);

  const canTransfer = !!selected && !selected.isDir;

  const commitCreate = async () => {
    const name = createDraft.trim();
    setCreating(false);
    setCreateDraft("");
    if (!name) return;
    setActionError("");
    try {
      await onMkdir(name);
    } catch (reason) {
      setActionError(String(reason));
    }
  };

  const commitRename = async () => {
    const target = renaming;
    const name = renameDraft.trim();
    setRenaming(null);
    if (!target || !name || name === target.name) return;
    setActionError("");
    try {
      await onRename(target, name);
    } catch (reason) {
      setActionError(String(reason));
    }
  };

  const confirmDelete = async () => {
    const target = pendingDelete;
    setPendingDelete(null);
    if (!target) return;
    setActionError("");
    try {
      await onDelete(target);
    } catch (reason) {
      setActionError(String(reason));
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

  const openMenu = (event: MouseEvent) => {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ x: rect.right, y: rect.bottom + 4 });
  };

  const startDrag = (event: DragEvent, entry: PanelEntry) => {
    dragging = { entry, side };
    event.dataTransfer.effectAllowed = "copy";
    // 带一点载荷：Chromium 对完全空的 dataTransfer 会直接取消这次拖拽
    event.dataTransfer.setData(DRAG_MIME, entry.path);
  };

  const endDrag = () => {
    dragging = null;
    setDropTarget(null);
  };

  /**
   * 拖到本面板上：只有「从对侧面板拖过来」才算数（同侧拖拽没有意义，
   * 自己拖给自己会变成自我覆盖）。落点目录在 `drop` 里才真正用得上，
   * 这里只负责判断能不能落 + 高亮。
   */
  const dragOver = (event: DragEvent, targetDir: string) => {
    if (!dragging || dragging.side === side || !dropDir) return;
    // 行上的处理器先跑，别让事件冒到列表区把落点从「该目录」改回「当前目录」
    event.stopPropagation();
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDropTarget(targetDir);
  };

  const drop = (event: DragEvent, targetDir: string) => {
    event.stopPropagation();
    setDropTarget(null);
    const payload = dragging;
    dragging = null;
    if (!payload || payload.side === side || !dropDir) return;
    event.preventDefault();
    if (targetDir === payload.entry.path) return; // 拖到自己身上
    onDropEntry(payload.entry, targetDir, payload.side);
  };

  const percent =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.transferred / progress.total) * 100))
      : null;

  const TransferIcon = side === "left" ? IconArrowRightToLine : IconArrowLeftToLine;

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      {/* 上行：面板标识 + 传输 + 更多 */}
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-line px-2">
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-fg-dim">
          <span className="shrink-0">{icon}</span>
          <span className="truncate text-[11px] font-medium tracking-wide">{label}</span>
        </span>
        <button type="button" onClick={onRefresh} title="重新列目录" className={HEAD_BUTTON}>
          <IconRefresh className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => selected && canTransfer && onTransfer(selected)}
          disabled={!canTransfer}
          title={
            side === "left"
              ? "把选中的文件传到右侧远程目录"
              : "把选中的文件下载到左侧本地目录"
          }
          className={HEAD_BUTTON}
        >
          <TransferIcon className="h-3.5 w-3.5" />
        </button>
        <button type="button" onClick={openMenu} title="更多" className={HEAD_BUTTON}>
          <IconMore className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* 下行：上一级 + 面包屑 */}
      <div className="flex h-7 shrink-0 items-center gap-1 border-b border-line px-2">
        <button
          type="button"
          disabled={!canUp}
          onClick={onUp}
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
                onClick={() => onNavigate(crumb.path)}
                className="rounded px-1 text-[11px] text-fg-dim hover:bg-hover hover:text-fg"
              >
                {crumb.name}
              </button>
            </span>
          ))}
        </div>
      </div>

      {error && (
        <div className="flex shrink-0 items-start gap-2 border-b border-danger-line bg-danger-bg px-2 py-1 text-[11px] text-danger">
          <span className="flex-1 break-all">{error}</span>
          <button
            type="button"
            onClick={onDismissError}
            className="shrink-0 rounded px-1 hover:bg-hover"
          >
            关闭
          </button>
        </div>
      )}
      {actionError && (
        <div className="flex shrink-0 items-start gap-2 border-b border-danger-line bg-danger-bg px-2 py-1 text-[11px] text-danger">
          <span className="flex-1 break-all">{actionError}</span>
          <button
            type="button"
            onClick={() => setActionError("")}
            className="shrink-0 rounded px-1 hover:bg-hover"
          >
            关闭
          </button>
        </div>
      )}

      {/* 落到空白 = 传到本面板当前目录；目录行在下面自己拦一层，优先作为落点 */}
      <div
        className={`min-h-0 flex-1 overflow-auto ${dropTarget === "" ? "bg-accent/10" : ""}`}
        onDragOver={(event) => dragOver(event, dropDir ?? "")}
        onDragLeave={(event) => {
          // 只在真正离开列表区时清高亮：在行之间移动会连着触发 leave，
          // 用 relatedTarget 是不是还在本区域内来判断。
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null);
        }}
        onDrop={(event) => drop(event, dropDir ?? "")}
      >
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
          <p className="px-3 py-4 text-[12px] text-fg-faint">正在定位目录…</p>
        )}
        {path && entries.length === 0 && !loading && !creating && (
          <p className="px-3 py-4 text-[12px] text-fg-faint">空目录</p>
        )}

        {entries.map((entry) => {
          const isRenaming = renaming?.path === entry.path;
          const isSelected = selected?.path === entry.path;
          const isDropDir = entry.isDir && dropTarget === entry.path;
          return (
            <div
              key={entry.path}
              onClick={() => onSelect(entry)}
              onDoubleClick={() => onActivate(entry)}
              draggable={!isRenaming}
              onDragStart={(event) => startDrag(event, entry)}
              onDragEnd={endDrag}
              // 目录行是传输落点；文件行不拦，事件冒到列表区 = 落到当前目录
              onDragOver={entry.isDir ? (event) => dragOver(event, entry.path) : undefined}
              onDrop={entry.isDir ? (event) => drop(event, entry.path) : undefined}
              title={entry.path}
              className={`flex h-6 cursor-default items-center gap-2 px-2 text-[12px] ${
                isDropDir
                  ? "bg-selected text-fg ring-1 ring-inset ring-accent"
                  : isSelected
                    ? "bg-selected text-fg"
                    : "text-fg-muted hover:bg-hover"
              }`}
            >
              {entry.isDir ? (
                <FolderTypeIcon name={entry.name} className="h-3.5 w-3.5 shrink-0 text-fg-dim" />
              ) : (
                <FileTypeIcon name={entry.name} className="h-3.5 w-3.5 shrink-0 text-fg-dim" />
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

      {menu && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setMenu(null)} />
          <div
            className="fixed z-40 flex flex-col rounded border border-line-strong bg-raised py-1 shadow-lg"
            style={{ width: MENU_W, left: Math.max(8, menu.x - MENU_W), top: menu.y }}
          >
            <button
              type="button"
              className={MENU_ITEM}
              onClick={() => {
                setMenu(null);
                onRefresh();
              }}
            >
              <IconRefresh className="mr-2 h-3.5 w-3.5 shrink-0" />
              刷新
            </button>
            <button
              type="button"
              className={MENU_ITEM}
              onClick={() => {
                setMenu(null);
                setCreateDraft("");
                setCreating(true);
                requestAnimationFrame(() => createRef.current?.focus());
              }}
            >
              <IconFolderPlus className="mr-2 h-3.5 w-3.5 shrink-0" />
              新建目录
            </button>
            <button
              type="button"
              disabled={!selected}
              className={MENU_ITEM}
              onClick={() => {
                if (!selected) return;
                setMenu(null);
                setRenameDraft(selected.name);
                setRenaming(selected);
                requestAnimationFrame(() => renameRef.current?.select());
              }}
            >
              <IconPencil className="mr-2 h-3.5 w-3.5 shrink-0" />
              重命名
            </button>
            <button
              type="button"
              disabled={!selected}
              className={`${MENU_ITEM} text-danger hover:text-danger`}
              onClick={() => {
                if (!selected) return;
                setMenu(null);
                setPendingDelete(selected);
              }}
            >
              <IconTrash className="mr-2 h-3.5 w-3.5 shrink-0" />
              删除
            </button>
          </div>
        </>
      )}

      {pendingDelete && (
        <ConfirmDialog
          message={`删除${pendingDelete.isDir ? "目录" : "文件"}「${pendingDelete.name}」${
            pendingDelete.isDir ? "及其中全部内容" : ""
          }？此操作不可撤销。`}
          confirmLabel="删除"
          onConfirm={() => void confirmDelete()}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </section>
  );
}
