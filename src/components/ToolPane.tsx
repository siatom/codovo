import type { MouseEvent as ReactMouseEvent } from "react";
import type { GitController } from "../lib/git";
import type { DiffSource } from "../lib/tabs";
import { ExplorerPane } from "./ExplorerPane";
import { GitChangesPane } from "./GitChangesPane";
import { SearchPane } from "./SearchPane";

/** 右栏的工具模块。浏览器不在这里渲染内容（它独占编辑器那一列），但入口在同一个图标条上 */
export type ToolId = "files" | "changes" | "search" | "browser";

const TOOL_KEY = "codedock.rightTool.";

const TOOLS: ToolId[] = ["files", "changes", "search", "browser"];

/**
 * 记住上次看的是哪个模块。面板本身每次启动都是收起的（跟左侧栏一个道理，
 * 不给终端让位就白搭），所以这里只存模块名，不存展开状态。
 *
 * key 里带上项目 root：一个窗口里同时开着多个项目，各看各的模块才不会串。
 * 用 sessionStorage 存，重启后回到「文件」，够用了。
 */
export function readTool(root: string): ToolId {
  try {
    const saved = window.sessionStorage.getItem(TOOL_KEY + root);
    return TOOLS.find((tool) => tool === saved) ?? "files";
  } catch {
    return "files";
  }
}

export function saveTool(root: string, tool: ToolId) {
  try {
    window.sessionStorage.setItem(TOOL_KEY + root, tool);
  } catch {
    // 记不住就每次启动回到「文件」，不影响使用
  }
}

interface ToolPaneProps {
  tool: ToolId;
  root: string;
  /** 这个项目是不是当前显示的。隐藏时不做任何后端交互 */
  visible: boolean;
  /** 当前打开的文件，文件树里要高亮 */
  selected: string | null;
  git: GitController;
  /** 文件树里点一个文件：打开文件内容 */
  onSelectFile: (path: string) => void;
  /** 改动列表 / 提交历史里点一个文件：打开差异视图 */
  onOpenDiff: (path: string, source: DiffSource) => void;
  /** 搜索结果里点一条：打开文件并定位到那一行那一列 */
  onOpenMatch: (path: string, line: number, column: number, length: number) => void;
  /** 替换前的落盘；返回 false 表示有文件没存成功，替换要中止 */
  onBeforeReplace: () => Promise<boolean>;
  /** 替换后让编辑器重新从磁盘加载这些文件 */
  onAfterReplace: (paths: string[]) => void;
  /** 文件树里改名前的落盘；返回 false 表示有文件没存成功，改名要中止 */
  onBeforeRename: () => Promise<boolean>;
  /** 文件树里改名成功：编辑器标签要跟着换路径 */
  onEntryRenamed: (from: string, to: string) => void;
  /** 文件树里删除成功：编辑器标签要关掉 */
  onEntryDeleted: (path: string) => void;
  /** 点面板上的空白处：切整条右边栏的显隐，和左侧栏一个手感 */
  onBlankClick: (event: ReactMouseEvent<HTMLElement>) => void;
}

/**
 * 各模块的内容。全都常挂载、只切可见性，这样文件树的展开态、提交草稿、
 * 上次的搜索结果在来回切换以及面板收起时都留得住。
 */
export function ToolPane({
  tool,
  root,
  visible,
  selected,
  git,
  onSelectFile,
  onOpenDiff,
  onOpenMatch,
  onBeforeReplace,
  onAfterReplace,
  onBeforeRename,
  onEntryRenamed,
  onEntryDeleted,
  onBlankClick,
}: ToolPaneProps) {
  const filesHidden = tool === "changes" || tool === "search";

  return (
    <section className="flex h-full min-h-0 flex-col bg-panel" onClick={onBlankClick}>
      <div className={filesHidden ? "hidden" : "flex min-h-0 flex-1 flex-col"}>
        <ExplorerPane
          root={root}
          selected={selected}
          gitMarks={git.snapshot.marks}
          isRepo={git.snapshot.isRepo}
          onSelect={onSelectFile}
          onBeforeRename={onBeforeRename}
          onRenamed={onEntryRenamed}
          onDeleted={onEntryDeleted}
        />
      </div>
      <div className={tool === "changes" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
        <GitChangesPane root={root} git={git} onOpen={onOpenDiff} />
      </div>
      <div className={tool === "search" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
        <SearchPane
          root={root}
          visible={visible}
          onOpenMatch={onOpenMatch}
          onBeforeReplace={onBeforeReplace}
          onAfterReplace={onAfterReplace}
        />
      </div>
    </section>
  );
}
