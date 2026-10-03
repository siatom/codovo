import { useEffect, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  gitClone,
  onCloneProgress,
  pickCloneParent,
  pickFolder,
  repoNameFromUrl,
  samePath,
  toDisplayPath,
} from "../lib/fs";
import type { CloneProgress } from "../lib/types";
import { folderName } from "../lib/workspaces";
import { IconCloudDownload, IconClose, IconFolder, IconFolderPlus } from "./icons";

interface WorkspaceDialogProps {
  mode: "create" | "edit";
  /** 编辑时的初值；创建时留空 */
  initialName?: string;
  initialRoots?: string[];
  onCancel: () => void;
  onSubmit: (value: { name: string; roots: string[] }) => void;
  /** 编辑模式才有：「移除本地工作区」——只从 CodeDock 的列表里去掉，不碰磁盘 */
  onRemove?: () => void;
}

const CANCEL_BUTTON =
  "rounded-md border border-line-strong px-3 py-1 text-[12px] text-fg-muted hover:bg-hover hover:text-fg";

/** 主操作（创建 / 保存）用实心强调色，跟别处的主按钮一致 */
const PRIMARY_BUTTON =
  "rounded-md bg-accent px-3 py-1 text-[12px] font-medium text-app hover:opacity-90 disabled:opacity-40 disabled:hover:opacity-40";

const REMOVE_BUTTON =
  "rounded-md border border-danger-line px-3 py-1 text-[12px] text-danger hover:bg-danger-bg";

/** 克隆表单里的输入框 */
const CLONE_INPUT =
  "h-8 w-full rounded-lg border border-line-strong bg-surface px-2.5 text-[13px] text-fg outline-none placeholder:text-fg-faint focus:border-accent";

/** 「本地目录 / 克隆仓库」分段切换的两种态 */
const TAB_BUTTON = "flex-1 rounded-md px-2 py-1 text-[12px] transition-colors";
const TAB_ACTIVE = `${TAB_BUTTON} bg-hover font-medium text-fg`;
const TAB_IDLE = `${TAB_BUTTON} text-fg-muted hover:text-fg`;

/**
 * 创建 / 编辑工作区的对话框：一个名字 + 一串工作目录。
 *
 * 「主要」= 列表第一项，文件树里排在最前，也是新建、点空白时的落点；把别的项
 * 「设为主要」就是把它挪到首位，不另存一个字段——两处状态很容易对不上。
 *
 * 外壳照 ConfirmDialog（遮罩 + 圆角卡片），同样不能改用 `window.confirm`：
 * WKWebView 上那套会静默失效。
 */
export function WorkspaceDialog({
  mode,
  initialName,
  initialRoots,
  onCancel,
  onSubmit,
  onRemove,
}: WorkspaceDialogProps) {
  const [name, setName] = useState(initialName ?? "");
  const [roots, setRoots] = useState<string[]>(initialRoots ?? []);
  const [error, setError] = useState<string | null>(null);
  /** 选择框开着，防止连点重复弹 */
  const [picking, setPicking] = useState(false);

  /** 创建模式下的两个子表单：本地目录 / 克隆仓库。编辑模式恒用 local */
  const [tab, setTab] = useState<"local" | "clone">("local");
  const [url, setUrl] = useState("");
  const [parent, setParent] = useState("");
  const [dirName, setDirName] = useState("");
  const [branch, setBranch] = useState("");
  const [shallow, setShallow] = useState(false);
  /** 用户手改过目录名之后，就不再跟着 URL 自动变 */
  const [nameTouched, setNameTouched] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [progress, setProgress] = useState<CloneProgress | null>(null);

  // 编辑模式没有切换器，即使 state 停在 clone 也要落回本地表单
  const activeTab = mode === "create" ? tab : "local";

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const switchTab = (next: "local" | "clone") => {
    setTab(next);
    setError(null);
    setProgress(null);
  };

  /** URL 变了就顺手刷新默认目录名，除非用户自己动过那个框 */
  const onUrlChange = (value: string) => {
    setUrl(value);
    if (!nameTouched) setDirName(repoNameFromUrl(value));
  };

  const chooseParent = async () => {
    if (picking) return;
    setPicking(true);
    setError(null);
    try {
      const picked = await pickCloneParent();
      if (picked) setParent(picked);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setPicking(false);
    }
  };

  /**
   * 开始克隆。进度事件按本次生成的 id 过滤，避免和别的克隆串台；成功后把克隆出的目录
   * 交给上层当新工作区打开（上层会关掉本对话框，所以成功分支不必再复位 cloning）。
   */
  const startClone = async () => {
    if (cloning) return;
    setError(null);
    if (!url.trim()) {
      setError("请填写仓库地址");
      return;
    }
    if (!parent) {
      setError("请选择克隆到的位置");
      return;
    }

    const id = crypto.randomUUID();
    setCloning(true);
    setProgress(null);
    let unlisten: UnlistenFn | undefined;
    try {
      unlisten = await onCloneProgress((event) => {
        if (event.id === id) setProgress(event);
      });
      const target = await gitClone({
        id,
        url,
        parent,
        name: dirName.trim() || undefined,
        branch: branch.trim() || undefined,
        depth: shallow ? 1 : undefined,
      });
      onSubmit({ name: dirName.trim() || repoNameFromUrl(url), roots: [target] });
    } catch (reason) {
      setError(String(reason));
      setCloning(false);
    } finally {
      unlisten?.();
    }
  };

  const addFolder = async () => {
    if (picking) return;
    setPicking(true);
    setError(null);
    try {
      const picked = await pickFolder();
      // 同一个目录加两次没有意义，按归一化路径去重（多选一次可能带回已存在的）
      if (picked.length > 0) {
        setRoots((current) => {
          const next = [...current];
          for (const path of picked) {
            if (!next.some((root) => samePath(root, path))) next.push(path);
          }
          return next;
        });
      }
    } catch (reason) {
      setError(String(reason));
    } finally {
      setPicking(false);
    }
  };

  const removeFolder = (target: string) => {
    setError(null);
    setRoots((current) => current.filter((root) => !samePath(root, target)));
  };

  /** 设为主要 = 挪到首位（列表顺序就是优先级） */
  const setPrimary = (target: string) => {
    setError(null);
    setRoots((current) => [target, ...current.filter((root) => !samePath(root, target))]);
  };

  const submit = () => {
    if (roots.length === 0) {
      setError("至少要添加一个工作目录");
      return;
    }
    onSubmit({ name: name.trim() || folderName(roots[0]), roots });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="flex max-h-full w-[420px] max-w-full flex-col rounded-xl border border-line-strong bg-raised p-4 shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-fg">
            {mode === "create" ? "新建工作区" : "编辑工作区"}
          </h2>
          <button
            type="button"
            onClick={onCancel}
            title="关闭"
            className="flex h-6 w-6 items-center justify-center rounded text-fg-dim hover:bg-hover hover:text-fg"
          >
            <IconClose className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* 创建时可选：本地目录 / 克隆仓库。编辑模式没有这个切换，恒走本地表单 */}
        {mode === "create" && (
          <div className="mb-3 flex gap-0.5 rounded-lg border border-line-strong bg-surface p-0.5">
            <button
              type="button"
              onClick={() => switchTab("local")}
              className={activeTab === "local" ? TAB_ACTIVE : TAB_IDLE}
            >
              本地目录
            </button>
            <button
              type="button"
              onClick={() => switchTab("clone")}
              className={activeTab === "clone" ? TAB_ACTIVE : TAB_IDLE}
            >
              克隆仓库
            </button>
          </div>
        )}

        {activeTab === "local" && (
          <>
            {/* 工作区名：整体是个带图标的输入框，失焦不提交，走下面的按钮 */}
            <div className="flex h-9 items-center gap-2 rounded-lg border border-line-strong bg-surface px-2.5 focus-within:border-accent">
              <IconFolder className="h-4 w-4 shrink-0 text-fg-dim" />
              <input
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") submit();
                }}
                placeholder="工作区名称"
                className="min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-fg-faint"
              />
            </div>

            <div className="mt-3 mb-1 flex items-baseline justify-between">
              <p className="text-[12px] font-medium text-fg-muted">工作目录</p>
              {/* 说清一个工作区能挂多个：空态只显示「添加」一个按钮，不点开看不出来 */}
              <span className="text-[11px] text-fg-faint">可添加一个或多个</span>
            </div>

            <div className="min-h-0 overflow-auto rounded-lg border border-line-strong">
              {roots.length === 0 ? (
                <div className="flex flex-col items-center gap-2 px-4 py-6">
                  <p className="text-[12px] text-fg-dim">在此电脑上添加工作目录</p>
                  <button
                    type="button"
                    onClick={() => void addFolder()}
                    disabled={picking}
                    className="flex items-center gap-1.5 rounded-md bg-hover px-3 py-1 text-[12px] text-fg-muted hover:bg-active hover:text-fg disabled:opacity-40"
                  >
                    <IconFolderPlus className="h-3.5 w-3.5" />
                    添加
                  </button>
                </div>
              ) : (
                <ul>
                  {roots.map((root, index) => (
                    <li
                      key={root}
                      className="group flex items-center gap-2 border-b border-line px-2.5 py-2 last:border-b-0"
                    >
                      <IconFolder className="h-4 w-4 shrink-0 text-fg-dim" />
                      <span
                        className="min-w-0 flex-1 truncate text-[13px] text-fg"
                        title={toDisplayPath(root)}
                      >
                        {folderName(root)}
                      </span>
                      {index === 0 ? (
                        <span className="shrink-0 rounded border border-line-strong px-1.5 py-0.5 text-[11px] text-fg-muted">
                          主要
                        </span>
                      ) : (
                        /* 平时藏起来、悬停才出现：静态时只留一个「主要」徽标，不喧宾夺主 */
                        <button
                          type="button"
                          onClick={() => setPrimary(root)}
                          title="设为主要工作目录"
                          className="shrink-0 rounded border border-line-strong px-1.5 py-0.5 text-[11px] text-fg-dim opacity-0 hover:text-fg group-hover:opacity-100"
                        >
                          设为主要
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => removeFolder(root)}
                        title="移除"
                        className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-faint hover:text-fg"
                      >
                        <IconClose className="h-3 w-3" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {roots.length > 0 && (
                <button
                  type="button"
                  onClick={() => void addFolder()}
                  disabled={picking}
                  className="flex w-full items-center gap-2 px-2.5 py-2 text-[13px] text-fg-muted hover:bg-hover hover:text-fg disabled:opacity-40"
                >
                  <IconFolderPlus className="h-4 w-4 shrink-0" />
                  添加工作目录
                </button>
              )}
            </div>
          </>
        )}

        {activeTab === "clone" && (
          <div className="flex flex-col gap-3">
            <div>
              <label className="mb-1 block text-[12px] font-medium text-fg-muted">仓库地址</label>
              <div className="flex h-9 items-center gap-2 rounded-lg border border-line-strong bg-surface px-2.5 focus-within:border-accent">
                <IconCloudDownload className="h-4 w-4 shrink-0 text-fg-dim" />
                <input
                  autoFocus
                  value={url}
                  onChange={(event) => onUrlChange(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void startClone();
                  }}
                  placeholder="https://github.com/owner/repo.git"
                  className="min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-fg-faint"
                />
              </div>
            </div>

            <div>
              <label className="mb-1 block text-[12px] font-medium text-fg-muted">克隆到</label>
              <div className="flex h-9 items-center gap-2 rounded-lg border border-line-strong bg-surface px-2.5">
                <IconFolder className="h-4 w-4 shrink-0 text-fg-dim" />
                <span
                  className="min-w-0 flex-1 truncate text-[13px] text-fg"
                  title={parent ? toDisplayPath(parent) : undefined}
                >
                  {parent ? toDisplayPath(parent) : <span className="text-fg-faint">未选择目录</span>}
                </span>
                <button
                  type="button"
                  onClick={() => void chooseParent()}
                  disabled={picking}
                  className="shrink-0 rounded-md bg-hover px-2 py-0.5 text-[12px] text-fg-muted hover:bg-active hover:text-fg disabled:opacity-40"
                >
                  选择
                </button>
              </div>
            </div>

            <div className="flex gap-3">
              <div className="min-w-0 flex-1">
                <label className="mb-1 block text-[12px] font-medium text-fg-muted">目录名</label>
                <input
                  value={dirName}
                  onChange={(event) => {
                    setNameTouched(true);
                    setDirName(event.target.value);
                  }}
                  placeholder="repo"
                  className={CLONE_INPUT}
                />
              </div>
              <div className="min-w-0 flex-1">
                <label className="mb-1 block text-[12px] font-medium text-fg-muted">分支</label>
                <input
                  value={branch}
                  onChange={(event) => setBranch(event.target.value)}
                  placeholder="默认分支"
                  className={CLONE_INPUT}
                />
              </div>
            </div>

            <label className="flex items-center gap-2 text-[12px] text-fg-muted">
              <input
                type="checkbox"
                checked={shallow}
                onChange={(event) => setShallow(event.target.checked)}
                className="h-3.5 w-3.5 accent-accent"
              />
              浅克隆（只取最新一次提交）
            </label>

            {cloning && (
              <div>
                <div className="mb-1 flex items-center justify-between gap-2 text-[11px] text-fg-muted">
                  <span className="truncate">{progress?.phase || "准备中…"}</span>
                  {progress?.percent != null && <span className="shrink-0">{progress.percent}%</span>}
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-hover">
                  <div
                    className="h-full rounded-full bg-accent transition-[width] duration-200"
                    style={{ width: progress?.percent != null ? `${progress.percent}%` : "30%" }}
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {error && <p className="mt-2 text-[11px] text-danger">{error}</p>}

        <div className="mt-4 flex items-center gap-2">
          {mode === "edit" && onRemove && (
            <button type="button" onClick={onRemove} className={REMOVE_BUTTON}>
              移除本地工作区
            </button>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button type="button" onClick={onCancel} className={CANCEL_BUTTON}>
              取消
            </button>
            {activeTab === "clone" ? (
              <button
                type="button"
                onClick={() => void startClone()}
                disabled={cloning || !url.trim() || !parent}
                className={PRIMARY_BUTTON}
              >
                {cloning ? "克隆中…" : "克隆"}
              </button>
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={roots.length === 0}
                className={PRIMARY_BUTTON}
              >
                {mode === "create" ? "新建工作区" : "保存"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
