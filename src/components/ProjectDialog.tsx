import { useEffect, useState } from "react";
import { pickFolder, samePath, toDisplayPath } from "../lib/fs";
import { folderName } from "../lib/projects";
import { IconClose, IconFolder, IconFolderPlus } from "./icons";

interface ProjectDialogProps {
  mode: "create" | "edit";
  /** 编辑时的初值；创建时留空 */
  initialName?: string;
  initialRoots?: string[];
  onCancel: () => void;
  onSubmit: (value: { name: string; roots: string[] }) => void;
  /** 编辑模式才有：「移除本地项目」——只从 CodeDock 的列表里去掉，不碰磁盘 */
  onRemove?: () => void;
}

const CANCEL_BUTTON =
  "rounded-md border border-line-strong px-3 py-1 text-[12px] text-fg-muted hover:bg-hover hover:text-fg";

/** 主操作（创建 / 保存）用实心强调色，跟别处的主按钮一致 */
const PRIMARY_BUTTON =
  "rounded-md bg-accent px-3 py-1 text-[12px] font-medium text-app hover:opacity-90 disabled:opacity-40 disabled:hover:opacity-40";

const REMOVE_BUTTON =
  "rounded-md border border-danger-line px-3 py-1 text-[12px] text-danger hover:bg-danger-bg";

/**
 * 创建 / 编辑项目的对话框：一个名字 + 一串源文件夹。
 *
 * 「主要」= 列表第一项，文件树里排在最前，也是新建、点空白时的落点；把别的项
 * 「设为主要」就是把它挪到首位，不另存一个字段——两处状态很容易对不上。
 *
 * 外壳照 ConfirmDialog（遮罩 + 圆角卡片），同样不能改用 `window.confirm`：
 * WKWebView 上那套会静默失效。
 */
export function ProjectDialog({
  mode,
  initialName,
  initialRoots,
  onCancel,
  onSubmit,
  onRemove,
}: ProjectDialogProps) {
  const [name, setName] = useState(initialName ?? "");
  const [roots, setRoots] = useState<string[]>(initialRoots ?? []);
  const [error, setError] = useState<string | null>(null);
  /** 选择框开着，防止连点重复弹 */
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const addFolder = async () => {
    if (picking) return;
    setPicking(true);
    setError(null);
    try {
      const picked = await pickFolder();
      // 同一个目录加两次没有意义，按归一化路径去重
      if (picked) {
        setRoots((current) =>
          current.some((root) => samePath(root, picked)) ? current : [...current, picked],
        );
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
      setError("至少要添加一个源文件夹");
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
            {mode === "create" ? "创建项目" : "编辑项目"}
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

        {/* 项目名：整体是个带图标的输入框，失焦不提交，走下面的按钮 */}
        <div className="flex h-9 items-center gap-2 rounded-lg border border-line-strong bg-surface px-2.5 focus-within:border-accent">
          <IconFolder className="h-4 w-4 shrink-0 text-fg-dim" />
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
            }}
            placeholder="项目名称"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-fg-faint"
          />
        </div>

        <p className="mt-3 mb-1 text-[12px] font-medium text-fg-muted">源文件夹</p>

        <div className="min-h-0 overflow-auto rounded-lg border border-line-strong">
          {roots.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-4 py-6">
              <p className="text-[12px] text-fg-dim">在此电脑上添加文件夹</p>
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
                      title="设为主要文件夹"
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
              添加文件夹
            </button>
          )}
        </div>

        {error && <p className="mt-2 text-[11px] text-danger">{error}</p>}

        <div className="mt-4 flex items-center gap-2">
          {mode === "edit" && onRemove && (
            <button type="button" onClick={onRemove} className={REMOVE_BUTTON}>
              移除本地项目
            </button>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button type="button" onClick={onCancel} className={CANCEL_BUTTON}>
              取消
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={roots.length === 0}
              className={PRIMARY_BUTTON}
            >
              {mode === "create" ? "创建项目" : "保存"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
