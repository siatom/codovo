import { useState } from "react";
import type { GitController, GitMark } from "../lib/git";
import type { DiffSource } from "../lib/tabs";
import { pathKey, toDisplayPath } from "../lib/fs";
import { folderName } from "../lib/projects";
import { ExplorerPane } from "./ExplorerPane";
import { GitChangesPane } from "./GitChangesPane";
import { SearchPane } from "./SearchPane";
import { IconChevronDown, IconChevronRight } from "./icons";

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
  /** 项目的全部源文件夹：文件树并列显示，变更面板按根分组，搜索挨个根搜 */
  roots: string[];
  /** 这个项目是不是当前显示的。隐藏时不做任何后端交互 */
  visible: boolean;
  /** 当前打开的文件，文件树里要高亮 */
  selected: string | null;
  /** 每根各一套 git 控制器：变更面板每个根挂一个完整的 */
  gitByRoot: Record<string, GitController>;
  /** 各根合并后的标记，供文件树查 */
  gitMarks: ReadonlyMap<string, GitMark>;
  /** 任意一根是 git 仓库。都不是时「变更」模块没有意义 */
  gitReady: boolean;
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
}

/**
 * 各模块的内容。全都常挂载、只切可见性，这样文件树的展开态、提交草稿、
 * 上次的搜索结果在来回切换以及面板收起时都留得住。
 */
export function ToolPane({
  tool,
  roots,
  visible,
  selected,
  gitByRoot,
  gitMarks,
  gitReady,
  onSelectFile,
  onOpenDiff,
  onOpenMatch,
  onBeforeReplace,
  onAfterReplace,
  onBeforeRename,
  onEntryRenamed,
  onEntryDeleted,
}: ToolPaneProps) {
  const filesHidden = tool === "changes" || tool === "search";
  /** 变更面板里被整块收起的源文件夹（归一化路径）。收起只留根名那一行 */
  const [collapsedRoots, setCollapsedRoots] = useState<ReadonlySet<string>>(new Set());

  const toggleRoot = (root: string) => {
    const key = pathKey(root);
    setCollapsedRoots((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <section className="flex h-full min-h-0 flex-col bg-panel">
      <div className={filesHidden ? "hidden" : "flex min-h-0 flex-1 flex-col"}>
        <ExplorerPane
          roots={roots}
          selected={selected}
          gitMarks={gitMarks}
          isRepo={gitReady}
          onSelect={onSelectFile}
          onBeforeRename={onBeforeRename}
          onRenamed={onEntryRenamed}
          onDeleted={onEntryDeleted}
        />
      </div>
      {/* 变更：每个源文件夹一块，各挂一个完整的变更面板。多根时每块能整块收起、只留
          根名那一行——两个仓库的改动加提交历史全铺开，一屏根本看不完。
          面板本身是 h-full 的整高布局（内部自己滚），所以展开的块按份数分高度、
          开了折叠就只占一行，块多了整体滚 */}
      <div className={tool === "changes" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
        {/* 模块自己的标题行，和「文件」「搜索」两个模块的头对齐（同为 h-8 + 下边框） */}
        <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-line px-3">
          <span className="min-w-0 flex-1 truncate text-[11px] font-medium tracking-wide text-fg-dim">
            变更
          </span>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        {roots.map((item) => {
          const collapsed = collapsedRoots.has(pathKey(item));
          return (
            <div
              key={item}
              // overflow-hidden 不只是裁内容：它把 flex item 的 min-height:auto 变成 0，
              // 否则 GitChangesPane 里长长的提交历史会把这一块撑开，把后面的根挤出可视区
              className={
                collapsed
                  ? "flex shrink-0 flex-col"
                  : "flex min-h-[300px] flex-1 flex-col overflow-hidden"
              }
            >
              {/* 单根时不加标题：面板自己的 header 已经在最上面了，没必要多一行 */}
              {roots.length > 1 && (
                <button
                  type="button"
                  onClick={() => toggleRoot(item)}
                  title={toDisplayPath(item)}
                  className="flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-left text-[11px] font-medium tracking-wide text-fg-dim hover:bg-hover hover:text-fg"
                >
                  {collapsed ? (
                    <IconChevronRight className="h-3 w-3 shrink-0" />
                  ) : (
                    <IconChevronDown className="h-3 w-3 shrink-0" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{folderName(item)}</span>
                </button>
              )}
              {/* 收起是藏起来、不是卸载：提交草稿、历史加载到第几页、拖过的高度都还在 */}
              <div className={collapsed ? "hidden" : "min-h-0 flex-1"}>
                <GitChangesPane root={item} git={gitByRoot[item]} onOpen={onOpenDiff} />
              </div>
            </div>
          );
        })}
        </div>
      </div>
      <div className={tool === "search" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
        <SearchPane
          roots={roots}
          visible={visible}
          onOpenMatch={onOpenMatch}
          onBeforeReplace={onBeforeReplace}
          onAfterReplace={onAfterReplace}
        />
      </div>
    </section>
  );
}
