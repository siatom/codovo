import type { FileEntry } from "../lib/types";
import { pathKey, toDisplayPath } from "../lib/fs";
import type { GitMark } from "../lib/git";
import { GitMarkBadge } from "./GitMarkBadge";
import {
  IconChevronDown,
  IconChevronRight,
  IconFile,
  IconFolder,
} from "./icons";

export interface TreeController {
  expanded: ReadonlySet<string>;
  loading: ReadonlySet<string>;
  errors: ReadonlyMap<string, string>;
  children: ReadonlyMap<string, FileEntry[]>;
  selected: string | null;
  /** 归一化路径 -> git 标记 */
  gitMarks: ReadonlyMap<string, GitMark>;
  toggle: (entry: FileEntry) => void;
  select: (entry: FileEntry) => void;
}

interface FileTreeNodeProps {
  entry: FileEntry;
  depth: number;
  tree: TreeController;
}

const INDENT = 12;

export function FileTreeNode({ entry, depth, tree }: FileTreeNodeProps) {
  const isOpen = entry.isDir && tree.expanded.has(entry.path);
  const isSelected = tree.selected === entry.path;
  const isLoading = tree.loading.has(entry.path);
  const error = tree.errors.get(entry.path);
  const childEntries = tree.children.get(entry.path) ?? [];
  const mark = tree.gitMarks.get(pathKey(entry.path));

  return (
    <li>
      <button
        type="button"
        title={toDisplayPath(entry.path)}
        onClick={() => (entry.isDir ? tree.toggle(entry) : tree.select(entry))}
        className={`flex w-full items-center gap-1.5 rounded px-1 py-[3px] text-left text-[12px] ${
          isSelected
            ? "bg-selected text-fg"
            : "text-fg-muted hover:bg-hover hover:text-fg"
        }`}
        style={{ paddingLeft: depth * INDENT + 4 }}
      >
        <span className="flex w-3 shrink-0 justify-center text-fg-icon">
          {entry.isDir &&
            (isOpen ? (
              <IconChevronDown className="h-3 w-3" />
            ) : (
              <IconChevronRight className="h-3 w-3" />
            ))}
        </span>
        <span className="flex shrink-0 items-center text-fg-icon">
          {entry.isDir ? (
            <IconFolder className="h-3.5 w-3.5" />
          ) : (
            <IconFile className="h-3.5 w-3.5" />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
        {mark && <GitMarkBadge mark={mark} className="text-[10px]" />}
        {isLoading && <span className="shrink-0 text-[10px] text-fg-faint">…</span>}
      </button>

      {error && (
        <p
          className="py-[2px] text-[11px] text-danger"
          style={{ paddingLeft: (depth + 1) * INDENT + 20 }}
        >
          {error}
        </p>
      )}

      {isOpen && childEntries.length > 0 && (
        <ul>
          {childEntries.map((child) => (
            <FileTreeNode key={child.path} entry={child} depth={depth + 1} tree={tree} />
          ))}
        </ul>
      )}
    </li>
  );
}
