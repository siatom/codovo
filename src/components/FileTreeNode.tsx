import type { MouseEvent } from "react";
import type { FileEntry } from "../lib/types";
import { pathKey, toDisplayPath } from "../lib/fs";
import type { GitMark } from "../lib/git";
import { GitMarkBadge } from "./GitMarkBadge";
import {
  FileTypeIcon,
  IconChevronDown,
  IconChevronRight,
  IconFolder,
} from "./icons";

export type CreateKind = "file" | "directory";

export interface CreatingState {
  kind: CreateKind;
  parent: string;
  value: string;
}

/** 正在就地改名的那一行。`original` 用来判断用户是不是压根没改 */
export interface RenamingState {
  path: string;
  original: string;
  value: string;
}

export interface TreeController {
  expanded: ReadonlySet<string>;
  loading: ReadonlySet<string>;
  errors: ReadonlyMap<string, string>;
  children: ReadonlyMap<string, FileEntry[]>;
  selected: string | null;
  /** 归一化路径 -> git 标记 */
  gitMarks: ReadonlyMap<string, GitMark>;
  /** 被 .gitignore 忽略的条目（归一化路径），这些行置灰 */
  ignored: ReadonlySet<string>;
  toggle: (entry: FileEntry) => void;
  select: (entry: FileEntry) => void;
  creating: CreatingState | null;
  createError: string | null;
  onCreateChange: (value: string) => void;
  onCreateSubmit: () => void;
  onCreateCancel: () => void;
  /** 右键一行：菜单由 ExplorerPane 统一画（它才知道菜单该贴哪、点完怎么刷新） */
  openMenu: (entry: FileEntry, event: MouseEvent) => void;
  renaming: RenamingState | null;
  renameError: string | null;
  onRenameChange: (value: string) => void;
  onRenameSubmit: () => void;
  onRenameCancel: () => void;
}

interface FileTreeNodeProps {
  entry: FileEntry;
  depth: number;
  tree: TreeController;
}

const INDENT = 12;

/** 悬停提示里的修改时间。自己拼而不用 toLocaleString：别处显示的格式不该随后端语言飘 */
function formatModified(ms: number): string {
  if (!ms) return "未知";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

export function FileTreeNode({ entry, depth, tree }: FileTreeNodeProps) {
  const isOpen = entry.isDir && tree.expanded.has(entry.path);
  const isSelected = tree.selected === entry.path;
  const isLoading = tree.loading.has(entry.path);
  const error = tree.errors.get(entry.path);
  const childEntries = tree.children.get(entry.path) ?? [];
  const mark = tree.gitMarks.get(pathKey(entry.path));
  const isIgnored = tree.ignored.has(pathKey(entry.path));
  const isCreatingHere = isOpen && tree.creating?.parent === entry.path;
  const isRenamingHere = tree.renaming?.path === entry.path;
  /**
   * 行的配色。被忽略的行用更淡的颜色，而且悬停**不**转亮——置灰要一直成立，
   * 否则鼠标扫过去以为它没被忽略。选中态优先，照旧用高亮底色。
   */
  const tone = isSelected
    ? "bg-selected text-fg"
    : isIgnored
      ? "text-fg-faint hover:bg-hover"
      : "text-fg-muted hover:bg-hover hover:text-fg";
  /** 图标降不透明度的类，前面自带空格，好直接拼进 className */
  const dim = isIgnored ? " opacity-50" : "";

  return (
    <li>
      {isRenamingHere && tree.renaming ? (
        <div style={{ paddingLeft: depth * INDENT + 4 }}>
          {/* 和行按钮同一个缩进、同一个行高，改完就地变回那一行 */}
          <input
            autoFocus
            value={tree.renaming.value}
            onChange={(event) => tree.onRenameChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                tree.onRenameSubmit();
              }
              if (event.key === "Escape") {
                // 别让 Esc 冒到窗口上：那里接着「退出全屏」
                event.stopPropagation();
                tree.onRenameCancel();
              }
            }}
            onFocus={(event) => {
              // 默认只选中主干名、把扩展名留下——改名多半只动主干（照 VS Code）。
              // 必须等一帧：React 会在 focus 之后才把 value 写进 DOM，那一下会把
              // 光标推到末尾，紧接着设的选中范围就白设了
              const input = event.target;
              const dot = entry.name.lastIndexOf(".");
              const end = dot > 0 ? dot : entry.name.length;
              requestAnimationFrame(() => input.setSelectionRange(0, end));
            }}
            onBlur={tree.onRenameSubmit}
            aria-label="重命名"
            className="h-6 w-full rounded border border-accent bg-surface px-1.5 text-[12px] text-fg outline-none"
          />
          {tree.renameError && (
            <p
              className="py-[2px] text-[11px] text-danger"
              style={{ paddingLeft: 20 }}
            >
              {tree.renameError}
            </p>
          )}
        </div>
      ) : (
        <button
          type="button"
          title={`${toDisplayPath(entry.path)}\n最近修改：${formatModified(entry.modified)}`}
          onClick={() => (entry.isDir ? tree.toggle(entry) : tree.select(entry))}
          onContextMenu={(event) => tree.openMenu(entry, event)}
          className={`flex w-full items-center gap-1.5 rounded px-1 py-[3px] text-left text-[12px] ${tone}`}
          style={{ paddingLeft: depth * INDENT + 4 }}
        >
          <span className={`flex w-3 shrink-0 justify-center text-fg-icon${dim}`}>
            {entry.isDir &&
              (isOpen ? (
                <IconChevronDown className="h-3 w-3" />
              ) : (
                <IconChevronRight className="h-3 w-3" />
              ))}
          </span>
          {/* 品牌色的文件图标也要跟着降不透明度：只把文字调淡、图标还鲜亮会很割裂 */}
          <span className={`flex shrink-0 items-center text-fg-icon${dim}`}>
            {entry.isDir ? (
              <IconFolder className="h-3.5 w-3.5" />
            ) : (
              <FileTypeIcon name={entry.name} className="h-3.5 w-3.5" />
            )}
          </span>
          <span className="min-w-0 flex-1 truncate">{entry.name}</span>
          {mark && <GitMarkBadge mark={mark} className="text-[10px]" />}
          {isLoading && <span className="shrink-0 text-[10px] text-fg-faint">…</span>}
        </button>
      )}

      {error && (
        <p
          className="py-[2px] text-[11px] text-danger"
          style={{ paddingLeft: (depth + 1) * INDENT + 20 }}
        >
          {error}
        </p>
      )}

      {isOpen && (isCreatingHere || childEntries.length > 0) && (
        <ul>
          {isCreatingHere && tree.creating && (
            <li>
              {/* 和上面的子行同一个缩进、同一个行高，输完直接变成本层的一行 */}
              <div style={{ paddingLeft: (depth + 1) * INDENT + 4 }}>
                <input
                  autoFocus
                  value={tree.creating.value}
                  onChange={(event) => tree.onCreateChange(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") tree.onCreateSubmit();
                    if (event.key === "Escape") {
                      event.stopPropagation();
                      tree.onCreateCancel();
                    }
                  }}
                  placeholder={tree.creating.kind === "file" ? "文件名" : "文件夹名"}
                  aria-label={tree.creating.kind === "file" ? "新建文件名" : "新建文件夹名"}
                  className="h-6 w-full rounded border border-accent bg-surface px-1.5 text-[12px] text-fg outline-none"
                />
              </div>
              {tree.createError && (
                <p className="py-[2px] text-[11px] text-danger" style={{ paddingLeft: (depth + 1) * INDENT + 20 }}>
                  {tree.createError}
                </p>
              )}
            </li>
          )}
          {childEntries.map((child) => (
            <FileTreeNode key={child.path} entry={child} depth={depth + 1} tree={tree} />
          ))}
        </ul>
      )}
    </li>
  );
}
