import { useCallback, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { SplitPane } from "./SplitPane";
import { TerminalPane, type TerminalPaneHandle } from "./TerminalPane";
import { ToolPane, readTool, saveTool, type ToolId } from "./ToolPane";
import { RIGHT_TOOLS, ToolRail } from "./ToolRail";
import { EditorPane, type EditorPaneHandle } from "./EditorPane";
import { BrowserPane } from "./BrowserPane";
import { useGitStatus } from "../lib/git";
import { useSettings } from "../lib/settings";
import { isBlankClick } from "../lib/dom";
import { isPathInside } from "../lib/fs";
import { sameTab, type DiffSource, type Tab } from "../lib/tabs";
import type { EditorLocation } from "../lib/types";

/** 交给 App 的两个 handle，供侧栏 AI CLI、编辑器浮窗路由到**当前项目**的实例 */
export interface WorkspaceHandles {
  terminal: TerminalPaneHandle | null;
  editor: EditorPaneHandle | null;
}

export type Fullscreen = "none" | "right" | "left";

interface ProjectWorkspaceProps {
  root: string;
  /** 是不是当前显示的那个项目。非当前的用 `hidden` 藏着，**不卸载** */
  visible: boolean;
  /** 全屏区域。放在 App 是因为它会连带隐藏侧边栏，属于窗口级布局 */
  fullscreen: Fullscreen;
  onToggleRightFullscreen: () => void;
  onToggleLeftFullscreen: () => void;
  /** 收起面板时顺带退出全屏（全屏按钮在面板里，面板收起来就点不到了） */
  onExitFullscreen: () => void;
  /** handle 挂上 / 卸载时上报，App 按 root 存起来 */
  onHandles: (root: string, handles: WorkspaceHandles) => void;
}

/**
 * 一个项目的右侧工作区：终端 / 智能体 + 右边栏。
 *
 * 每个打开的项目各挂一个实例，切项目只是切 `visible`——非当前的 `display:none`
 * 藏着、不卸载，于是终端会话、Monaco model、文件树展开态天然保留，切回来是原样。
 * 代价是这个实例的状态不能依赖「外部换 key 重置」，那套在这里会丢东西。
 */
export function ProjectWorkspace({
  root,
  visible,
  fullscreen,
  onToggleRightFullscreen,
  onToggleLeftFullscreen,
  onExitFullscreen,
  onHandles,
}: ProjectWorkspaceProps) {
  // 编辑器标签按打开顺序排，activeTab 是当前显示的那个。
  // 标签身份是结构化的（文件 / 差异视图），不能只拿路径当键，见 lib/tabs.ts
  const [openTabs, setOpenTabs] = useState<Tab[]>([]);
  const [activeTab, setActiveTab] = useState<Tab | null>(null);
  /** 右栏看的是哪个模块（每个项目各记一份） */
  const [tool, setTool] = useState<ToolId>(() => readTool(root));
  /** 右边栏的内容面板是否展开。图标条本身常驻，收起时右边只留一条图标条 */
  const [rightOpen, setRightOpen] = useState(false);

  // 只有当前显示的项目需要轮询 git，其余的一直在跑就是白烧 CPU
  const git = useGitStatus(root, visible);
  const { settings } = useSettings();

  const gitReady = git.snapshot.isRepo;
  // 设置里关掉的模块不上图标条。顺序以图标条的注册表为准，加模块只要往那边加一条
  const toolVisible: Record<ToolId, boolean> = {
    files: settings.rightFilesVisible,
    changes: settings.rightChangesVisible,
    search: settings.rightSearchVisible,
    browser: settings.rightBrowserVisible,
  };
  // 当前模块被关掉、或者不是仓库看不了「变更」时，落到第一个还开着的模块。
  // 派生值兜底而不是改 state：用户选的模块不会被抹掉，重新打开设置里的开关就回到原样
  const firstVisible: ToolId =
    RIGHT_TOOLS.map((item) => item.id).find(
      (id) => toolVisible[id] && (id !== "changes" || gitReady),
    ) ?? "files";
  const activeTool: ToolId =
    toolVisible[tool] && (tool !== "changes" || gitReady) ? tool : firstVisible;
  const rightCollapsed = !rightOpen;
  // 两种全屏的派生值：右栏全屏时左侧让位，左侧全屏时右栏（连图标条）整体让位
  const rightFullscreen = fullscreen === "right";
  const leftFullscreen = fullscreen === "left";

  const pickTool = useCallback(
    (id: ToolId) => {
      // 图标条常驻，所以再点一次当前模块就是收起内容面板（照 VS Code 那套）
      if (rightOpen && id === activeTool) {
        setRightOpen(false);
        // 收起右栏就得退出全屏，否则两列同时收起，会剩一条点不动的图标条和 0 宽的终端
        onExitFullscreen();
        return;
      }
      setTool(id);
      saveTool(root, id);
      setRightOpen(true);
    },
    [rightOpen, activeTool, root, onExitFullscreen],
  );

  const toggleRight = useCallback(() => {
    setRightOpen((open) => !open);
    onExitFullscreen();
  }, [onExitFullscreen]);

  /**
   * 点右边栏自己的空白处切显隐。只挂在图标条和工具面板上——编辑器是主区域，
   * 不算「右边栏」，浏览器模块的内容是 iframe，点进去的事件根本出不来。
   * 全屏时整块在铺满窗口，不响应，退出全屏走 Esc 或全屏按钮。
   */
  const onBlankClick = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      if (fullscreen !== "none") return;
      if (!isBlankClick(event)) return;
      setRightOpen((open) => !open);
    },
    [fullscreen],
  );

  /** AI CLI 的入口挂在侧边栏的项目行上，命令要落到当前项目终端那边的活动会话里 */
  const terminalRef = useRef<TerminalPaneHandle>(null);
  /** 搜索替换要指挥编辑器保存 / 重载 / 定位，这几件事只有它自己知道怎么做 */
  const editorRef = useRef<EditorPaneHandle>(null);

  // handle 交回 App：侧栏的命令、编辑器的浮窗都得打在**当前项目**的实例上。
  // 用回调 ref 上报，不能靠 effect——ref 变化不会触发渲染
  const handlesRef = useRef<WorkspaceHandles>({ terminal: null, editor: null });
  const reportHandles = useCallback(() => {
    onHandles(root, { ...handlesRef.current });
  }, [root, onHandles]);

  const setTerminalHandle = useCallback(
    (handle: TerminalPaneHandle | null) => {
      terminalRef.current = handle;
      handlesRef.current.terminal = handle;
      reportHandles();
    },
    [reportHandles],
  );

  const setEditorHandle = useCallback(
    (handle: EditorPaneHandle | null) => {
      editorRef.current = handle;
      handlesRef.current.editor = handle;
      reportHandles();
    },
    [reportHandles],
  );

  /** 编辑器浮窗：把位置引用送到终端会话 / 智能体输入框，两者都在 TerminalPane 里 */
  const insertToTerminal = useCallback((location: EditorLocation) => {
    terminalRef.current?.insertToTerminal(location);
  }, []);

  const insertToAgent = useCallback((location: EditorLocation) => {
    terminalRef.current?.insertToAgent(location);
  }, []);

  /** 已经开着的标签只切过去，不重复开——连点同一个改动项就是这个路径 */
  const openTab = useCallback((tab: Tab) => {
    setOpenTabs((current) =>
      current.some((item) => sameTab(item, tab)) ? current : [...current, tab],
    );
    setActiveTab(tab);
  }, []);

  const openFile = useCallback(
    (path: string) => {
      openTab({ kind: "file", path });
    },
    [openTab],
  );

  /** 从「变更」列表或提交历史点进来的：开的是差异视图，不是文件内容 */
  const openDiff = useCallback(
    (path: string, source: DiffSource) => {
      openTab({ kind: "diff", path, source });
    },
    [openTab],
  );

  /** 点同一条结果也要能重新定位一次，靠它每次造一个新对象 */
  const revealNonceRef = useRef(0);

  /** 搜索结果里点一条：打开文件并把光标送到那一处 */
  const openMatch = useCallback(
    (path: string, line: number, column: number, length: number) => {
      openTab({ kind: "file", path });
      editorRef.current?.revealAt({
        path,
        line,
        column,
        length,
        nonce: (revealNonceRef.current += 1),
      });
    },
    [openTab],
  );

  /** 替换前先把编辑器里没保存的改动落盘；存不成功就不替换 */
  const saveAllEdits = useCallback(async () => {
    return (await editorRef.current?.saveAll()) ?? true;
  }, []);

  /** 替换之后让编辑器丢掉旧内容、重新读磁盘 */
  const reloadAfterReplace = useCallback((paths: string[]) => {
    void editorRef.current?.reload(paths);
  }, []);

  /**
   * 文件树里改了名：编辑器里落在旧路径下的标签换到新路径去。
   * model 直接丢掉，由编辑器按新路径重读——改名前的未保存改动已经落过盘了。
   */
  const renameOpenTabs = useCallback((from: string, to: string) => {
    editorRef.current?.dropPaths([from]);
    const moved = (path: string) => isPathInside(path, from);
    const nextPath = (path: string) => to + path.slice(from.length);
    setOpenTabs((current) =>
      current.map((tab) => (moved(tab.path) ? { ...tab, path: nextPath(tab.path) } : tab)),
    );
    setActiveTab((current) =>
      current && moved(current.path) ? { ...current, path: nextPath(current.path) } : current,
    );
  }, []);

  /** 文件树里删了东西：落在它下面的标签一并关掉，当前标签落到它右边那个 */
  const dropOpenTabs = useCallback(
    (path: string) => {
      editorRef.current?.dropPaths([path]);
      const index = openTabs.findIndex((tab) => isPathInside(tab.path, path));
      if (index === -1) return;
      const rest = openTabs.filter((tab) => !isPathInside(tab.path, path));
      setOpenTabs(rest);
      if (activeTab && isPathInside(activeTab.path, path)) {
        setActiveTab(rest[Math.min(index, rest.length - 1)] ?? null);
      }
    },
    [openTabs, activeTab],
  );

  const closeTab = useCallback(
    (tab: Tab) => {
      const index = openTabs.findIndex((item) => sameTab(item, tab));
      if (index === -1) return;
      const rest = openTabs.filter((item) => !sameTab(item, tab));
      setOpenTabs(rest);
      // 关掉的是当前标签时，焦点落到它右边那个（没有就往左退一格）
      if (activeTab && sameTab(activeTab, tab)) {
        setActiveTab(rest[Math.min(index, rest.length - 1)] ?? null);
      }
    },
    [openTabs, activeTab],
  );

  /** 标题栏「⋯」菜单：一次关掉全部标签 */
  const closeAllTabs = useCallback(() => {
    setOpenTabs([]);
    setActiveTab(null);
  }, []);

  /** 标题栏「⋯」菜单：只留当前标签 */
  const closeOtherTabs = useCallback(() => {
    if (!activeTab) return;
    setOpenTabs([activeTab]);
  }, [activeTab]);

  return (
    <div className={visible ? "contents" : "hidden"}>
      <SplitPane
        initial={52}
        min={20}
        max={78}
        // 左栏全屏时右栏整列让位（连图标条一起）；平时收起右栏仍是原来的窄条状态
        secondCollapsed={rightCollapsed || leftFullscreen}
        firstCollapsed={rightFullscreen}
        first={
          <TerminalPane
            root={root}
            visible={visible}
            ref={setTerminalHandle}
            fullscreen={leftFullscreen}
            onToggleFullscreen={onToggleLeftFullscreen}
          />
        }
        second={
          // 左栏全屏时整块右栏藏起来（连图标条一起）。contents 让这层壳不参与布局，
          // 内容只是藏起来、不卸载，Monaco 的撤销历史和 iframe 都留得住
          <div className={leftFullscreen ? "hidden" : "contents"}>
            <div className="flex min-h-0 min-w-0 flex-1">
              <ToolRail
                active={activeTool}
                gitReady={gitReady}
                changed={git.snapshot.changed}
                visible={toolVisible}
                onPick={pickTool}
                rightOpen={rightOpen}
                onToggleRight={toggleRight}
                onBlankClick={onBlankClick}
              />
              {/* 浏览器选中时独占编辑器那一列。编辑区只是隐藏、不卸载，
                  Monaco 的撤销历史和文件树的展开态都留得住。
                  收起面板时整块内容一起藏起来，图标条单独留着。
                  全屏时整块右边栏一起铺满窗口，编辑器那一列照常留着 */}
              <div
                className={
                  rightOpen && activeTool !== "browser"
                    ? "flex min-h-0 min-w-0 flex-1"
                    : "hidden"
                }
              >
                <SplitPane
                  initial={28}
                  min={12}
                  max={45}
                  first={
                    <ToolPane
                      tool={activeTool}
                      root={root}
                      visible={visible}
                      selected={activeTab?.kind === "file" ? activeTab.path : null}
                      git={git}
                      onSelectFile={openFile}
                      onOpenDiff={openDiff}
                      onOpenMatch={openMatch}
                      onBeforeReplace={saveAllEdits}
                      onAfterReplace={reloadAfterReplace}
                      onBeforeRename={saveAllEdits}
                      onEntryRenamed={renameOpenTabs}
                      onEntryDeleted={dropOpenTabs}
                      onBlankClick={onBlankClick}
                    />
                  }
                  second={
                    <EditorPane
                      ref={setEditorHandle}
                      root={root}
                      visible={visible}
                      tabs={openTabs}
                      active={activeTab}
                      gitMarks={git.snapshot.marks}
                      onActivate={setActiveTab}
                      onClose={closeTab}
                      onCloseAll={closeAllTabs}
                      onCloseOthers={closeOtherTabs}
                      fullscreen={rightFullscreen}
                      onToggleFullscreen={onToggleRightFullscreen}
                      onSendToTerminal={insertToTerminal}
                      onSendToAgent={insertToAgent}
                    />
                  }
                />
              </div>
              <div
                className={
                  rightOpen && activeTool === "browser"
                    ? "flex min-h-0 min-w-0 flex-1"
                    : "hidden"
                }
              >
                <BrowserPane
                  root={root}
                  fullscreen={rightFullscreen}
                  onToggleFullscreen={onToggleRightFullscreen}
                />
              </div>
            </div>
          </div>
        }
      />
    </div>
  );
}
