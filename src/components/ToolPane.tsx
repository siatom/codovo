import type { GitController } from "../lib/git";
import { ExplorerPane } from "./ExplorerPane";
import { GitChangesPane } from "./GitChangesPane";

/** 右栏的工具模块。浏览器不在这里渲染内容（它独占编辑器那一列），但入口在同一个图标条上 */
export type ToolId = "files" | "changes" | "browser";

const TOOL_KEY = "codedock.rightTool";

const TOOLS: ToolId[] = ["files", "changes", "browser"];

/**
 * 记住上次看的是哪个模块。面板本身每次启动都是收起的（跟左侧栏一个道理，
 * 不给终端让位就白搭），所以这里只存模块名，不存展开状态。
 */
export function readTool(): ToolId {
  try {
    const saved = window.localStorage.getItem(TOOL_KEY);
    return TOOLS.find((tool) => tool === saved) ?? "files";
  } catch {
    return "files";
  }
}

export function saveTool(tool: ToolId) {
  try {
    window.localStorage.setItem(TOOL_KEY, tool);
  } catch {
    // 记不住就每次启动回到「文件」，不影响使用
  }
}

interface ToolPaneProps {
  tool: ToolId;
  root: string;
  /** 当前打开的文件，文件树里要高亮 */
  selected: string | null;
  git: GitController;
  /** 文件树里点一个文件：打开文件内容 */
  onSelectFile: (path: string) => void;
  /** 改动列表里点一个改动项：打开差异视图 */
  onOpenDiff: (path: string, staged: boolean) => void;
  /** 全屏展示状态，透给两个模块标题栏右端那个按钮 */
  fullscreen: boolean;
  onToggleFullscreen: () => void;
}

/**
 * 「文件」和「变更」两个模块的内容。两个都常挂载、只切可见性，
 * 这样文件树的展开态和提交草稿在来回切换、以及面板收起时都留得住。
 * 浏览器选中时这里整块是收起的，文件列表保持挂载、不影响展开态。
 */
export function ToolPane({
  tool,
  root,
  selected,
  git,
  onSelectFile,
  onOpenDiff,
  fullscreen,
  onToggleFullscreen,
}: ToolPaneProps) {
  return (
    <section className="flex h-full min-h-0 flex-col bg-panel">
      <div className={tool === "changes" ? "hidden" : "flex min-h-0 flex-1 flex-col"}>
        <ExplorerPane
          root={root}
          selected={selected}
          gitMarks={git.snapshot.marks}
          onSelect={onSelectFile}
          fullscreen={fullscreen}
          onToggleFullscreen={onToggleFullscreen}
        />
      </div>
      <div className={tool === "changes" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
        {/* 换工作区丢掉上一个仓库残留的提交草稿和报错 */}
        <GitChangesPane
          key={root}
          git={git}
          onOpen={onOpenDiff}
          fullscreen={fullscreen}
          onToggleFullscreen={onToggleFullscreen}
        />
      </div>
    </section>
  );
}
