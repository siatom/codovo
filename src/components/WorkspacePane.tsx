import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { SplitPane } from "./SplitPane";
import { TerminalPane, type TerminalPaneHandle } from "./TerminalPane";
import { ToolPane, readTool, saveTool, type ToolId } from "./ToolPane";
import { RIGHT_TOOLS, ToolRail } from "./ToolRail";
import { EditorPane, type EditorPaneHandle } from "./EditorPane";
import { BrowserPane } from "./BrowserPane";
import { DatabasePane } from "./DatabasePane";
import { DeployPane } from "./DeployPane";
import { PreviewPane } from "./PreviewPane";
import { RemotePane } from "./RemotePane";
import { controllerOf, useGitStatus, type GitController } from "../lib/git";
import { useSettings } from "../lib/settings";
import { isBlankClick } from "../lib/dom";
import { isPathInside, ownerRoot, pathKey, toDisplayPath, type MovePair } from "../lib/fs";
import { sameTab, type DiffSource, type Tab } from "../lib/tabs";
import type { EditorLocation } from "../lib/types";
import type { Workspace } from "../lib/workspaces";
import type { BrowserFileRequest } from "./BrowserPane";

/** 交给 App 的两个 handle，供侧栏 AI CLI、编辑器浮窗路由到**当前工作区**的实例 */
export interface WorkspaceHandles {
  terminal: TerminalPaneHandle | null;
  editor: EditorPaneHandle | null;
  /** 界面布局的入口：应用助手要能切右栏模块、收放右边栏 */
  layout: WorkspaceLayoutHandle | null;
}

/**
 * 界面布局的可编程入口。应用助手（`lib/app-agent.ts`）通过它操作**当前活动工作区**的
 * 右栏——布局状态是每个工作区实例自己的 state，只能由实例自己改。
 */
export interface WorkspaceLayoutHandle {
  /** 展开右栏并切到某个模块（不做「再点一次收起」的切换语义，那是图标条点击才有的） */
  openTool: (id: ToolId) => void;
  /** 展开 / 收起右边栏的内容面板 */
  setRightOpen: (open: boolean) => void;
}

export type Fullscreen = "none" | "right" | "left";

interface WorkspacePaneProps {
  /** 这个工作区：名字、全部工作目录、以及当前活动根 */
  workspace: Workspace;
  /** 是不是当前显示的那个工作区。非当前的用 `hidden` 藏着，**不卸载** */
  visible: boolean;
  /** 全屏区域。放在 App 是因为它会连带隐藏侧边栏，属于窗口级布局 */
  fullscreen: Fullscreen;
  onToggleRightFullscreen: () => void;
  onToggleLeftFullscreen: () => void;
  /** 收起面板时顺带退出全屏（全屏按钮在面板里，面板收起来就点不到了） */
  onExitFullscreen: () => void;
  /** handle 挂上 / 卸载时上报，App 按**工作区 id** 存起来 */
  onHandles: (workspaceId: string, handles: WorkspaceHandles) => void;
}

/**
 * 一个工作区实例的右侧：终端 / 智能体 + 右边栏。
 *
 * 实例是**按工作区**挂的（`key` 用工作区 id）——一个工作区可以有多个工作目录，
 * 文件树把它们并列显示；其余单根概念（终端、变更、搜索、浏览器）跟活动根走。
 * 切工作区只是切 `visible`——非当前的 `display:none` 藏着、不卸载，于是终端会话、
 * Monaco model、文件树展开态天然保留，切回来是原样。代价是这个实例的状态不能
 * 依赖「外部换 key 重置」，那套在这里会丢东西。
 */
export function WorkspacePane({
  workspace,
  visible,
  fullscreen,
  onToggleRightFullscreen,
  onToggleLeftFullscreen,
  onExitFullscreen,
  onHandles,
}: WorkspacePaneProps) {
  /** 工作区内当前活动根：终端 / 变更 / 搜索 / 浏览器都开在它上面 */
  const root = workspace.activeRoot;

  // 编辑器标签按打开顺序排，activeTab 是当前显示的那个。
  // 标签身份是结构化的（文件 / 差异视图），不能只拿路径当键，见 lib/tabs.ts
  const [openTabs, setOpenTabs] = useState<Tab[]>([]);
  const [activeTab, setActiveTab] = useState<Tab | null>(null);
  /** 右栏看的是哪个模块（按活动根各记一份） */
  const [tool, setTool] = useState<ToolId>(() => readTool(root));
  /** 右边栏的内容面板是否展开。图标条本身常驻，收起时右边只留一条图标条 */
  const [rightOpen, setRightOpen] = useState(false);
  /** 文件树右键送来的「用内置浏览器打开这个文件」，交给浏览器模块 */
  const [browserFile, setBrowserFile] = useState<BrowserFileRequest | null>(null);

  // 工作区内换了活动根（比如把另一个工作目录设为主要），右栏模块跟着换成那个根上次看的。
  // 实例不重建，所以初始值那一次不会重跑，得显式同步
  useEffect(() => {
    setTool(readTool(root));
  }, [root]);

  /**
   * 每个工作目录在「变更」面板里实际看的 git 目标。默认就是它自己；用户在面板里
   * 选了别的 worktree 后，这里记的是那个 worktree 的路径（后端已登记进白名单）。
   *
   * 只影响「变更」面板这一个模块：文件树 / 终端 / 编辑器仍然跟工作区根走。
   */
  const [wtMap, setWtMap] = useState<Record<string, string>>({});
  const pickWorktree = useCallback((workRoot: string, target: string) => {
    setWtMap((current) => {
      const next = { ...current };
      if (target === workRoot) delete next[workRoot];
      else next[workRoot] = target;
      return next;
    });
  }, []);

  // 变更面板实际看的是这些目标（根，或被选中的 worktree）；图标条的徽标也按它们算
  const gitRoots = useMemo(
    () => workspace.roots.map((item) => wtMap[item] ?? item),
    [workspace.roots, wtMap],
  );

  /**
   * 轮询目标：工作区根 **加上** 被选中的 worktree。
   *
   * 工作区根必须一起轮——文件树、标签页上的改动标记来自它们。只换「变更」面板看哪
   * 个 worktree，不该让文件树上的标记跟着消失（合起来的 marks 里多出的 worktree 路径
   * 跟工作区内的路径不会撞，是白搭的几项，无害）。
   */
  const pollRoots = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of [...workspace.roots, ...gitRoots]) {
      const key = pathKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    return out;
  }, [workspace.roots, gitRoots]);

  // 「变更」模块是不是真的露在用户眼前：右栏展开、且当前看的正是它。收起右栏 / 停在
  // 别的模块时外层只是把它 `hidden` 藏着、组件还活着，所以变更面板里那几个轮询 effect
  // 得靠它短路，否则不可见时仍在白跑 git。用原始 state `tool` 而不是派生的 `activeTool`，
  // 和下面 numstat 的判据保持一致。
  const changesVisible = rightOpen && tool === "changes";

  // 只有当前显示的工作区需要轮询 git，其余的一直在跑就是白烧 CPU。
  // 行数（numstat）只在「变更」面板可见时才要：轮询每 2 秒一次，面板收着或看别的
  // 模块时那两次 numstat 纯属浪费。这里用原始 state `tool` 判断而不是派生的
  // `activeTool`——后者还会被「模块被关掉」的兜底改掉，拿它当依赖等于让 hook 跟着
  // 别处的设置一起变。tool 指向非仓库时后端在 numstat 之前就短路，等价于不跑
  const git = useGitStatus(pollRoots, visible, changesVisible);
  const { settings } = useSettings();

  // 变更面板按根分组，每根挂一个完整的面板，各自拿自己的控制器
  const gitByRoot = useMemo(() => {
    const out: Record<string, GitController> = {};
    for (const item of gitRoots) out[item] = controllerOf(git, item);
    return out;
  }, [git, gitRoots]);

  /** 图标条角标：只数「变更」面板实际看的那些工作树，选中的 worktree 顶替它自己的根 */
  const changedCount = useMemo(
    () => gitRoots.reduce((total, item) => total + (git.byRoot[item]?.changed ?? 0), 0),
    [gitRoots, git.byRoot],
  );

  const gitReady = git.isRepo;
  // 设置里关掉的模块不上图标条。顺序以图标条的注册表为准，加模块只要往那边加一条
  const toolVisible: Record<ToolId, boolean> = {
    files: settings.rightFilesVisible,
    changes: settings.rightChangesVisible,
    browser: settings.rightBrowserVisible,
    remote: settings.rightRemoteVisible,
    database: settings.rightDatabaseVisible,
    preview: settings.rightPreviewVisible,
    deploy: settings.rightDeployVisible,
  };
  // 当前模块被关掉时落到第一个还开着的模块。派生值兜底而不是改 state：
  // 用户选的模块不会被抹掉，重新打开设置里的开关就回到原样。
  // 「变更」不再因为目录不是仓库而回退——点进去是空状态 + 初始化按钮
  const firstVisible: ToolId =
    RIGHT_TOOLS.map((item) => item.id).find((id) => toolVisible[id]) ?? "files";
  const activeTool: ToolId = toolVisible[tool] ? tool : firstVisible;
  // 「文件」模块是不是真的露在用户眼前：右栏展开、且当前显示的正是它。
  // 用 activeTool 而不是原始 tool——模块被设置关掉时会回落到别的模块，
  // 那时文件树和内容搜索都不该在后台白跑（树会重列、内容搜索会整仓遍历）
  const filesVisible = rightOpen && activeTool === "files";
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
   * 界面操作智能体（应用助手）用的布局入口。刻意和 `pickTool` 分开：那边「再点一次当前
   * 模块 = 收起」的切换语义是给图标条点击的，而工具调用说「切到变更面板」就该切过去、
   * 不该因为面板正开着而把它收起来。
   */
  const layoutHandle = useMemo<WorkspaceLayoutHandle>(
    () => ({
      openTool: (id) => {
        setTool(id);
        saveTool(root, id);
        setRightOpen(true);
      },
      setRightOpen: (open) => setRightOpen(open),
    }),
    [root],
  );

  /**
   * 点图标条上的空白处切显隐，和左侧栏一个手感——这是收起/展开右边栏的唯一空白区。
   * 工具面板的内容区不挂它：文件树等模块自己要用空白点击（收回锚点、清高亮），
   * 沾上「收起整条右栏」会误伤。编辑器是主区域、浏览器内容是 iframe，本来也不该算。
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

  /** AI CLI 的入口挂在侧边栏的工作区行上，命令要落到当前工作区终端那边的活动会话里 */
  const terminalRef = useRef<TerminalPaneHandle>(null);
  /** 搜索替换要指挥编辑器保存 / 重载 / 定位，这几件事只有它自己知道怎么做 */
  const editorRef = useRef<EditorPaneHandle>(null);

  // handle 交回 App：侧栏的命令、编辑器的浮窗都得打在**当前工作区**的实例上。
  // 用回调 ref 上报，不能靠 effect——ref 变化不会触发渲染
  const handlesRef = useRef<WorkspaceHandles>({ terminal: null, editor: null, layout: null });
  const reportHandles = useCallback(() => {
    onHandles(workspace.id, { ...handlesRef.current });
  }, [workspace.id, onHandles]);

  // 布局句柄上报给 App：应用助手要按工作区 id 找到当前实例的右栏去操作
  useEffect(() => {
    handlesRef.current.layout = layoutHandle;
    reportHandles();
  }, [layoutHandle, reportHandles]);

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

  /** 从「变更」列表或时间线点进来的：开的是差异视图，不是文件内容 */
  const openDiff = useCallback(
    (path: string, source: DiffSource) => {
      openTab({ kind: "diff", path, source });
    },
    [openTab],
  );

  /** 点同一条结果也要能重新定位一次，靠它每次造一个新对象 */
  const revealNonceRef = useRef(0);

  /** 连点同一个网页文件也要重新加载一次，靠它每次造一个新对象 */
  const browserNonceRef = useRef(0);

  /**
   * 文件树右键网页文件 → 丢给右栏的「浏览器」模块预览。
   *
   * 加载走 asset 协议（地址在 `BrowserPane` 里拼）：WebView2 不让 http 源的 iframe 读
   * `file://`，而把内容塞进 srcdoc 又会让相对路径的 css / js / 图片全部失效。asset 协议
   * 由后端按工作区根放行（见 `fs_api::allow_asset_preview`），相对路径天然能解析。
   */
  const openInBrowser = useCallback(
    (path: string) => {
      // 地址栏里显示工作区内的相对路径，比一长串绝对路径好认
      const owner = ownerRoot(workspace.roots, path);
      const full = toDisplayPath(path);
      const base = owner ? toDisplayPath(owner).replace(/\/+$/, "") : "";
      const label = base && full.startsWith(`${base}/`) ? full.slice(base.length + 1) : full;
      setBrowserFile({ path, label, nonce: (browserNonceRef.current += 1) });
      // 切到浏览器模块并展开。不能走 pickTool——它在本模块已经选中时是「收起面板」
      setTool("browser");
      saveTool(root, "browser");
      setRightOpen(true);
    },
    [root, workspace.roots],
  );

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
   * 文件树里改名 / 移动了东西：编辑器里落在旧路径下的标签换到新路径去。
   * model 直接丢掉，由编辑器按新路径重读——改动前的未保存内容已经落过盘了。
   * 一次可能来一批（批量移动），所以要一次性算好，别逐项调用（会各算各的旧 openTabs）。
   */
  const renameOpenTabs = useCallback((moves: MovePair[]) => {
    if (moves.length === 0) return;
    editorRef.current?.dropPaths(moves.map((move) => move.from));
    const nextPath = (path: string) => {
      for (const move of moves) {
        if (isPathInside(path, move.from)) return move.to + path.slice(move.from.length);
      }
      return path;
    };
    setOpenTabs((current) =>
      current.map((tab) => {
        const next = nextPath(tab.path);
        return next === tab.path ? tab : { ...tab, path: next };
      }),
    );
    setActiveTab((current) => {
      if (!current) return current;
      const next = nextPath(current.path);
      return next === current.path ? current : { ...current, path: next };
    });
  }, []);

  /** 文件树里删了东西：落在这些路径下的标签一并关掉，当前标签落到它右边那个 */
  const dropOpenTabs = useCallback(
    (paths: string[]) => {
      if (paths.length === 0) return;
      const removed = (path: string) => paths.some((item) => isPathInside(path, item));
      editorRef.current?.dropPaths(paths);
      const index = openTabs.findIndex((tab) => removed(tab.path));
      if (index === -1) return;
      const rest = openTabs.filter((tab) => !removed(tab.path));
      setOpenTabs(rest);
      if (activeTab && removed(activeTab.path)) {
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

  /** 编辑器标签拖动重排：只换 openTabs 的顺序，激活的标签对象不变、dirty 标记跟着标签走 */
  const reorderTabs = useCallback((from: number, to: number) => {
    setOpenTabs((current) => {
      if (from < 0 || from >= current.length || from === to) return current;
      const next = [...current];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }, []);

  /**
   * 变更面板里切了分支：整个工作区被换成那条分支的内容，按旧内容缓存下来的东西
   * 全都不能信了。
   *
   * 三件事：
   * 1. 差异视图的基线（HEAD / index / 某个提交）全部作废 —— model 缓存的 key 里
   *    不含分支，留着就会拿旧基线跟新内容比，显示出根本不存在的差异。
   * 2. 打开着的文件重读一遍 —— watcher 只会给「改动过的文件」发事件，被 checkout
   *    删掉的文件收不到通知，标签里会一直留着那份已经不存在的内容。
   * 3. 上一步读不回来的（文件确实没了）关掉标签，别留一堆死标签。
   */
  const onBranchChanged = useCallback(async () => {
    const editor = editorRef.current;
    if (!editor) return;
    // 先作废所有差异标签：它们的基线跟着 HEAD 走，跨分支必然过期
    editor.dropDiffs();
    const paths = openTabs.map((tab) => tab.path);
    await editor.reload(paths);
    const missing = await editor.missingPaths(paths);
    if (missing.length > 0) {
      const gone = new Set(missing.map(pathKey));
      const rest = openTabs.filter((tab) => !gone.has(pathKey(tab.path)));
      editor.dropPaths(missing);
      setOpenTabs(rest);
      setActiveTab((current) =>
        current && gone.has(pathKey(current.path)) ? (rest[rest.length - 1] ?? null) : current,
      );
    }
  }, [openTabs]);

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
        // 双击这条主分栏线（终端 / 右边栏）复位成均分
        resetOnDoubleClick
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
                changed={changedCount}
                visible={toolVisible}
                onPick={pickTool}
                rightOpen={rightOpen}
                onToggleRight={toggleRight}
                onBlankClick={onBlankClick}
              />
              {/* 浏览器 / 远程连接 / 数据库选中时独占编辑器那一列。编辑区只是隐藏、不卸载，
                  Monaco 的撤销历史和文件树的展开态都留得住。
                  收起面板时整块内容一起藏起来，图标条单独留着。
                  全屏时整块右边栏一起铺满窗口，编辑器那一列照常留着 */}
              <div
                className={
                  rightOpen &&
                  activeTool !== "browser" &&
                  activeTool !== "remote" &&
                  activeTool !== "database" &&
                  activeTool !== "preview" &&
                  activeTool !== "deploy"
                    ? "flex min-h-0 min-w-0 flex-1"
                    : "hidden"
                }
              >
                <SplitPane
                  initial={32}
                  min={12}
                  max={45}
                  first={
                    <ToolPane
                      tool={activeTool}
                      roots={workspace.roots}
                      visible={visible}
                      filesVisible={filesVisible}
                      changesVisible={changesVisible}
                      selected={activeTab?.kind === "file" ? activeTab.path : null}
                      gitByRoot={gitByRoot}
                      gitTargets={wtMap}
                      gitMarks={git.marks}
                      gitReady={gitReady}
                      onSelectFile={openFile}
                      onOpenInBrowser={openInBrowser}
                      onOpenDiff={openDiff}
                      onOpenMatch={openMatch}
                      onPickWorktree={pickWorktree}
                      onBranchChanged={() => void onBranchChanged()}
                      onBeforeBranchSwitch={saveAllEdits}
                      onBeforeReplace={saveAllEdits}
                      onAfterReplace={reloadAfterReplace}
                      onBeforeRename={saveAllEdits}
                      onEntryRenamed={renameOpenTabs}
                      onEntryDeleted={dropOpenTabs}
                      onRequestCloseTab={() => editorRef.current?.closeActiveTab()}
                    />
                  }
                  second={
                    <EditorPane
                      ref={setEditorHandle}
                      root={root}
                      roots={pollRoots}
                      visible={visible}
                      tabs={openTabs}
                      active={activeTab}
                      gitMarks={git.marks}
                      onActivate={setActiveTab}
                      onClose={closeTab}
                      onReorder={reorderTabs}
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
                  request={browserFile}
                  fullscreen={rightFullscreen}
                  onToggleFullscreen={onToggleRightFullscreen}
                />
              </div>
              <div
                className={
                  rightOpen && activeTool === "remote"
                    ? "flex min-h-0 min-w-0 flex-1"
                    : "hidden"
                }
              >
                <RemotePane
                  fullscreen={rightFullscreen}
                  onToggleFullscreen={onToggleRightFullscreen}
                />
              </div>
              <div
                className={
                  rightOpen && activeTool === "database"
                    ? "flex min-h-0 min-w-0 flex-1"
                    : "hidden"
                }
              >
                <DatabasePane
                  fullscreen={rightFullscreen}
                  onToggleFullscreen={onToggleRightFullscreen}
                />
              </div>
              <div
                className={
                  rightOpen && activeTool === "preview"
                    ? "flex min-h-0 min-w-0 flex-1"
                    : "hidden"
                }
              >
                <PreviewPane
                  root={root}
                  visible={rightOpen && activeTool === "preview"}
                  fullscreen={rightFullscreen}
                  onToggleFullscreen={onToggleRightFullscreen}
                />
              </div>
              <div
                className={
                  rightOpen && activeTool === "deploy"
                    ? "flex min-h-0 min-w-0 flex-1"
                    : "hidden"
                }
              >
                <DeployPane
                  root={root}
                  visible={rightOpen && activeTool === "deploy"}
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
