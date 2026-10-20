import { IconFile, IconFolderOpen, IconClose } from "./icons";
import { removeRecent, useRecentFiles } from "../lib/recent";
import { useSettings } from "../lib/settings";
import { formatShortcut } from "../lib/shortcuts";
import { toDisplayPath } from "../lib/fs";

interface WelcomeScreenProps {
  /** 弹出单文件选择框（Ctrl+O 同一条流程） */
  onOpenFile: () => void;
  /** 弹出目录选择框，选中后打开为工作区 */
  onOpenFolder: () => void;
  /** 点击最近文件：可能落在当前工作区，也可能需要临时工作区，由上层路由 */
  onOpenRecent: (path: string) => void;
}

/** 最近文件的相对时间：今天只给时分，今年省掉年份，更早的给完整日期 */
function formatOpenedAt(timestamp: number): string {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (sameDay) return time;
  if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

const ACTION =
  "flex w-full items-center gap-2.5 rounded-lg border border-line bg-raised px-3 py-2 text-left text-[12px] text-fg-muted transition-colors hover:border-line-strong hover:bg-hover hover:text-fg";

/**
 * 编辑器没有标签时的欢迎页：最近文件 + 打开入口。
 *
 * 这里刻意不放编辑器的其他功能（新建缓冲区在标签栏、文件树在右栏），
 * 空态只回答「接下来打开什么」。
 */
export function WelcomeScreen({ onOpenFile, onOpenFolder, onOpenRecent }: WelcomeScreenProps) {
  const recent = useRecentFiles();
  const { settings } = useSettings();
  const openShortcut = formatShortcut(settings.shortcuts["editor.openFile"]);

  return (
    <div className="absolute inset-0 overflow-auto bg-surface">
      <div className="mx-auto flex w-full max-w-[560px] flex-col gap-6 px-6 py-10">
        <div>
          <h1 className="text-[15px] font-semibold text-fg">开始编辑</h1>
          <p className="mt-1 text-[12px] text-fg-faint">
            从一个文件开始，或把文件夹作为工作区打开。
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <button type="button" onClick={onOpenFile} className={ACTION}>
            <IconFile className="h-4 w-4 shrink-0 text-fg-dim" />
            <span className="flex-1">打开文件…</span>
            <span className="shrink-0 text-[11px] text-fg-faint">{openShortcut}</span>
          </button>
          <button type="button" onClick={onOpenFolder} className={ACTION}>
            <IconFolderOpen className="h-4 w-4 shrink-0 text-fg-dim" />
            <span className="flex-1">打开文件夹…</span>
          </button>
        </div>

        <section className="flex min-h-0 flex-col">
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="text-[13px] font-semibold tracking-wide text-fg-dim">最近打开</h2>
            {recent.length > 0 && (
              <span className="text-[11px] text-fg-faint">最多保留 50 条</span>
            )}
          </div>

          {recent.length === 0 ? (
            <p className="rounded-lg border border-line bg-panel px-3 py-4 text-[12px] leading-relaxed text-fg-faint">
              还没有最近文件，打开过的文件会出现在这里，点击即可重新打开。
            </p>
          ) : (
            <ul className="flex max-h-[46vh] flex-col overflow-auto rounded-lg border border-line bg-panel p-1">
              {recent.map((entry) => (
                <li key={entry.path} className="group flex items-center gap-2 rounded-md hover:bg-hover">
                  <button
                    type="button"
                    onClick={() => onOpenRecent(entry.path)}
                    title={`${toDisplayPath(entry.path)}\n点击打开`}
                    className="flex min-w-0 flex-1 items-center gap-2.5 px-2 py-1.5 text-left"
                  >
                    <IconFile className="h-3.5 w-3.5 shrink-0 text-fg-faint" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-[12px] text-fg-muted group-hover:text-fg">
                        {entry.name}
                      </span>
                      <span className="truncate text-[10px] text-fg-faint">
                        {toDisplayPath(entry.path)}
                      </span>
                    </span>
                    <span className="shrink-0 text-[10px] tabular-nums text-fg-faint">
                      {formatOpenedAt(entry.openedAt)}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => removeRecent(entry.path)}
                    title="从最近列表移除"
                    className="mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-faint opacity-0 hover:bg-active hover:text-fg group-hover:opacity-100 focus-visible:opacity-100"
                  >
                    <IconClose className="h-3 w-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
