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
import { RIGHT_TOOLS, RAIL_WIDTH, ToolRail } from "./ToolRail";
import { EditorPane, type EditorPaneHandle } from "./EditorPane";
import { BrowserPane } from "./BrowserPane";
import { DatabasePane } from "./DatabasePane";
import { DeployPane } from "./DeployPane";
import { PreviewPane } from "./PreviewPane";
import { RemotePane } from "./RemotePane";
import { IconEye } from "./icons";
import { controllerOf, useGitStatus, type GitController } from "../lib/git";
import { useSettings } from "../lib/settings";
import { isBlankClick } from "../lib/dom";
import { beginLayoutAnimation } from "../lib/layout-motion";
import { isPathInside, ownerRoot, pathKey, pathsPresent, samePath, toDisplayPath, type MovePair } from "../lib/fs";
import { readSession, scheduleSessionSave } from "../lib/session";
import {
  newUntitledTab,
  openFileTab,
  patchTab,
  sameTab,
  tabKey,
  tabName,
  type DiffSource,
  type Tab,
  type TabPatch,
} from "../lib/tabs";
import type { EditorLocation, TerminalSessionInfo } from "../lib/types";
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

type WorkspaceTask = "terminal" | "files" | "browser" | "remote" | "database" | "preview" | "deploy";

/**
 * 关闭标签时的匹配。另存为会把未命名缓冲区的 `path` 换成真实路径、但 `untitledId` 不变；
 * 「保存并关闭」收尾时父级的标签列表可能还停在另存为之前那一份，按 id 兜住。
 */
function sameTabForClose(a: Tab, b: Tab): boolean {
  if (sameTab(a, b)) return true;
  return (
    a.kind === "file" &&
    b.kind === "file" &&
    a.untitledId !== undefined &&
    a.untitledId === b.untitledId
  );
}

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
  /** 编辑器浮窗「送给助手」：由 App 展开助手抽屉并插入位置引用 */
  onSendToAssistant: (location: EditorLocation) => void;
  /** 打开设置面板（编辑器翻译视图里的「设置」入口） */
  onOpenSettings: () => void;
  /**
   * 打开一个不落在本工作区任何根下的文件。Ctrl+O、系统拖放都可能指向
   * 工作区外的文件，由 App 建 / 复用临时工作区后把请求转回来。
   */
  onOpenFileAnywhere: (path: string) => void;
  /**
   * 交给本工作区打开的跨工作区请求队列（App 建好临时工作区后回填）。nonce 保证同一条
   * 路径连点两次也能重新执行；只看队首，处理完带上 nonce 由 `onOpenRequestHandled` 移除。
   */
  openRequests: Array<{ workspaceId: string; path: string; nonce: number }>;
  onOpenRequestHandled: (nonce: number) => void;
}

/**
 * 一个工作区实例的主工作区：超级 tab 在终端与工具任务间切换，最右侧保留工具图标栏。
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
  onSendToAssistant,
  onOpenSettings,
  onOpenFileAnywhere,
  openRequests,
  onOpenRequestHandled,
}: WorkspacePaneProps) {
  /** 工作区内当前活动根：终端 / 变更 / 搜索 / 浏览器都开在它上面 */
  const root = workspace.activeRoot;

  // 编辑器标签按打开顺序排，activeTab 是当前显示的那个。
  // 标签身份是结构化的（文件 / 差异视图），不能只拿路径当键，见 lib/tabs.ts
  const [openTabs, setOpenTabs] = useState<Tab[]>([]);
  const [activeTab, setActiveTab] = useState<Tab | null>(null);
  /** 工作区主视图的超级 tab；工具内容与终端共享同一组顶层入口 */
  const [activeTask, setActiveTask] = useState<WorkspaceTask>("terminal");
  const [taskTabs, setTaskTabs] = useState<WorkspaceTask[]>(["terminal"]);
  /** 最新标签列表的快照：会话恢复是异步的，要能在读盘途中判断用户是否已经手动开了文件 */
  const openTabsRef = useRef<Tab[]>([]);
  openTabsRef.current = openTabs;
  /** 右栏看的是哪个模块（按活动根各记一份） */
  const [tool, setTool] = useState<ToolId>(() => readTool(root));
  /** 右边栏的内容面板是否展开。图标条本身常驻，收起时右边只留一条图标条 */
  const [rightOpen, setRightOpen] = useState(true);
  const [taskSidebarTarget, setTaskSidebarTarget] = useState<HTMLDivElement | null>(null);
  /** 文件树右键送来的「用内置浏览器打开这个文件」，交给浏览器模块 */
  const [browserFile, setBrowserFile] = useState<BrowserFileRequest | null>(null);
  /**
   * 「打开所在目录」的请求（编辑器标签右键发起）：带着 nonce 一路传给文件树，
   * 树据此展开到这个文件。右栏同时切到「文件」模块。
   */
  const [filesReveal, setFilesReveal] = useState<{ path: string; nonce: number } | null>(null);
  /** 上面那个请求的序号：同一条路径再点一次也要重新定位 */
  const filesRevealNonceRef = useRef(0);
  /** 已经触发过打开请求的 nonce：父级移除状态前可能多渲染一帧，别重复打开 */
  const handledOpenRequestRef = useRef(0);
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
  /**
   * 终端会话归属（id / cwd / 是否在等用户），由 TerminalPane 上报。
   * 变更雷达靠它判断「哪个工作树上有终端在跑、谁在等我」——attention store 是按
   * 工作区根记的，落不到具体工作树上，所以要多这一份。
   */
  const [terminalSessions, setTerminalSessions] = useState<TerminalSessionInfo[]>([]);
  /** 变更雷达的「去看」：切到该目录的终端，没有就新开一个 */
  const openTerminalAt = useCallback((cwd: string) => {
    terminalRef.current?.focusOrOpenAt(cwd);
  }, []);
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
  const taskHasSidebar = activeTool !== "browser";
  // 两种全屏的派生值：右栏全屏时左侧让位，左侧全屏时右栏（连图标条）整体让位
  const rightFullscreen = fullscreen === "right";
  const leftFullscreen = fullscreen === "left";

  /**
   * 右栏收放、左栏全屏都会连续改变中间终端 / 编辑器的宽度。先标记动画时段，
   * 终端和编辑器据此把 fit / layout 推后到动画结束（见 lib/layout-motion）。
   * 用快照比较而不是「跳过第一次」：StrictMode 会把 effect 跑两遍，跳过第一次
   * 会在启动时误标一次动画。
   */
  const layoutMotionRef = useRef({ rightOpen, leftFullscreen });
  useEffect(() => {
    const prev = layoutMotionRef.current;
    if (prev.rightOpen === rightOpen && prev.leftFullscreen === leftFullscreen) return;
    layoutMotionRef.current = { rightOpen, leftFullscreen };
    beginLayoutAnimation();
  }, [rightOpen, leftFullscreen]);

  const openTask = useCallback(
    (id: WorkspaceTask) => {
      setActiveTask(id);
      setTaskTabs((current) => (current.includes(id) ? current : [...current, id]));
      if (id === "files") {
        setTool("files");
        saveTool(root, "files");
        setRightOpen(true);
      }
    },
    [root],
  );

  const pickTool = useCallback(
    (id: ToolId) => {
      setTool(id);
      saveTool(root, id);
      setRightOpen(true);
      if (id === "browser") openTask("browser");
    },
    [openTask, root],
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
      openTool: (id) => pickTool(id),
      setRightOpen: (open) => setRightOpen(open),
    }),
    [pickTool],
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

  /** 编辑器浮窗：把位置引用送到当前终端会话 */
  const insertToTerminal = useCallback((location: EditorLocation) => {
    terminalRef.current?.insertToTerminal(location);
  }, []);

  /** 编辑器浮窗：送给应用助手——展开抽屉并把位置引用插进它的输入框（由 App 实现） */
  const insertToAssistant = useCallback(
    (location: EditorLocation) => {
      onSendToAssistant(location);
    },
    [onSendToAssistant],
  );

  /**
   * 编辑器标签右键「打开所在目录」：先把右栏切到「文件」模块，再把带序号的请求交给
   * 文件树去展开定位。切模块不能走 pickTool——它在当前模块已选中时是「收起面板」
   */
  const revealInFiles = useCallback(
    (path: string) => {
      setTool("files");
      saveTool(root, "files");
      setRightOpen(true);
      setFilesReveal({ path, nonce: (filesRevealNonceRef.current += 1) });
    },
    [root],
  );

  /** 已经开着的标签只切过去，不重复开——连点同一个改动项就是这个路径 */
  const openTab = useCallback((tab: Tab) => {
    setActiveTask("files");
    setTaskTabs((current) => (current.includes("files") ? current : [...current, "files"]));
    const nextSidebar = tab.kind === "diff" ? "changes" : "files";
    setTool(nextSidebar);
    saveTool(root, nextSidebar);
    setRightOpen(true);
    setOpenTabs((current) => current.length === 1 && sameTab(current[0], tab) ? current : [tab]);
    setActiveTab(tab);
  }, [root]);

  const openFile = useCallback(
    (path: string) => {
      // 不在本工作区任何根下的文件走 App：由它建 / 复用临时工作区再转回来，
      // 沙箱不在这里放宽，真正的读写仍由后端按白名单校验
      if (ownerRoot(workspace.roots, path) === null) {
        onOpenFileAnywhere(path);
        return;
      }
      openTab(openFileTab(path));
    },
    [onOpenFileAnywhere, openTab, workspace.roots],
  );

  /**
   * 新建未命名缓冲区。序号只在本工作区内自增，标签身份（tabKey）靠它，
   * 所以关掉再开不会撞车、也不会和已有标签混成一个。
   */
  const untitledSeqRef = useRef(0);
  const newUntitled = useCallback(() => {
    untitledSeqRef.current += 1;
    openTab(newUntitledTab(String(untitledSeqRef.current)));
  }, [openTab]);

  // ---- 会话恢复 / 落盘 ----

  /** 是否已经走过一次恢复。恢复完成前不写会话，免得把空标签列表覆盖上去 */
  const sessionRestoredRef = useRef(false);

  /**
   * 实例挂载时恢复上次的标签。工作区根在 App 里已经 activate 成 canonical 路径，
   * 这里只做过滤和读取；路径已被删掉（`paths_present` 为 false）的静默跳过。
   *
   * 只恢复普通文件标签：差异视图依赖当时的 git 状态，未命名缓冲区没有落盘内容。
   */
  useEffect(() => {
    const session = readSession(workspace.id);
    const candidates = session
      ? session.paths.filter((path) => ownerRoot(workspace.roots, path) !== null)
      : [];
    if (!session || candidates.length === 0) {
      sessionRestoredRef.current = true;
      return;
    }

    let cancelled = false;
    void pathsPresent(candidates)
      .then((flags) => {
        if (cancelled) return;
        const valid = candidates.filter((_, index) => flags[index]);
        // 读盘途中用户可能已经手动开了文件：不能拿旧会话把当前标签盖掉
        if (valid.length > 0 && openTabsRef.current.length === 0) {
          const restoredPath =
            session.active && valid.some((path) => samePath(path, session.active!))
              ? session.active
              : valid[0];
          const tabs = [openFileTab(restoredPath)];
          setOpenTabs(tabs);
          const wanted = session.active;
          const active =
            (wanted !== null &&
              tabs.find((tab) => tab.path !== null && samePath(tab.path, wanted))) ||
            tabs[0];
          setActiveTab(active);
        }
        sessionRestoredRef.current = true;
      })
      .catch(() => {
        // 校验失败就当作没有可恢复的标签，不阻断正常使用
        if (!cancelled) sessionRestoredRef.current = true;
      });

    return () => {
      cancelled = true;
    };
    // 只在实例挂载时恢复一次：roots 变化（编辑工作区）不该重建标签列表
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 标签打开 / 关闭 / 激活 / 重排时防抖写入。只存已落盘的普通文件路径，
   * 未命名缓冲区与差异视图不进会话；数组顺序就是标签顺序。
   */
  useEffect(() => {
    if (!sessionRestoredRef.current) return;
    const paths: string[] = [];
    const seen = new Set<string>();
    for (const tab of openTabs) {
      if (tab.kind !== "file" || tab.path === null) continue;
      const key = pathKey(tab.path);
      if (seen.has(key)) continue;
      seen.add(key);
      paths.push(tab.path);
    }
    scheduleSessionSave(workspace.id, {
      paths,
      active: activeTab?.kind === "file" ? activeTab.path : null,
    });
  }, [openTabs, activeTab, workspace.id]);

  /** App 建好 / 切好临时工作区后转回来的单文件请求：只看队首，处理完按 nonce 移除 */
  useEffect(() => {
    const request = openRequests[0];
    if (!request || request.workspaceId !== workspace.id) return;
    if (request.nonce <= handledOpenRequestRef.current) return;
    handledOpenRequestRef.current = request.nonce;
    if (ownerRoot(workspace.roots, request.path) !== null) {
      openFile(request.path);
    }
    onOpenRequestHandled(request.nonce);
  }, [openRequests, workspace.id, workspace.roots, openFile, onOpenRequestHandled]);

  /**
   * 改标签的元数据（另存为改路径、外部变更改标记）。匹配按**改之前**的 key：
   * 另存为会把路径换掉，用新路径反查就找不到这条标签了。
   */
  const patchOpenTab = useCallback((tab: Tab, patch: TabPatch) => {
    const key = tabKey(tab);
    setOpenTabs((current) =>
      current.map((item) => (tabKey(item) === key ? patchTab(item, patch) : item)),
    );
    setActiveTab((current) =>
      current && tabKey(current) === key ? patchTab(current, patch) : current,
    );
  }, []);

  /** 从「变更」列表或时间线点进来的：开的是差异视图，不是文件内容 */
  const openDiff = useCallback(
    (path: string, source: DiffSource) => {
      const name = toDisplayPath(path).split("/").pop()?.toLowerCase() ?? "";
      const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
      // 图片是二进制内容，差异视图无法展示有意义的变更；直接打开文件预览。
      if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif"].includes(extension)) {
        openTab(openFileTab(path));
        return;
      }
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
      openTask("browser");
    },
    [openTask, workspace.roots],
  );

  /**
   * 文件树右键「格式化文档」：先把文件打开（已开则只切过去），再请编辑器格式化。
   * 编辑器负责「model 还没就绪」的那段时间——见 EditorPane 的 formatPath。
   */
  const formatFile = useCallback(
    (path: string) => {
      openFile(path);
      editorRef.current?.formatPath(path);
    },
    [openFile],
  );

  /** 搜索结果里点一条：打开文件并把光标送到那一处 */
  const openMatch = useCallback(
    (path: string, line: number, column: number, length: number) => {
      openTab(openFileTab(path));
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

  /** 终端输出里的文件引用：打开文件并跳到行首 */
  const openTerminalFile = useCallback(
    (path: string, line: number) => {
      if (ownerRoot(workspace.roots, path) === null) return;
      setTool("files");
      openTask("files");
      saveTool(root, "files");
      setRightOpen(true);
      onExitFullscreen();
      openFile(path);
      editorRef.current?.revealAt({
        path,
        line,
        column: 1,
        length: 0,
        nonce: (revealNonceRef.current += 1),
      });
    },
    [openFile, onExitFullscreen, openTask, root, workspace.roots],
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
    // 未命名缓冲区没有路径，改名跟它无关，原样留着
    const renameTab = (tab: Tab): Tab =>
      tab.path === null ? tab : { ...tab, path: nextPath(tab.path) };
    setOpenTabs((current) => current.map(renameTab));
    setActiveTab((current) => (current ? renameTab(current) : current));
  }, []);

  /** 文件树里删了东西：落在这些路径下的标签一并关掉，当前标签落到它右边那个 */
  const dropOpenTabs = useCallback(
    (paths: string[]) => {
      if (paths.length === 0) return;
      const removed = (tab: Tab) => {
        const path = tab.path;
        return path !== null && paths.some((item) => isPathInside(path, item));
      };
      editorRef.current?.dropPaths(paths);
      const index = openTabs.findIndex(removed);
      if (index === -1) return;
      const rest = openTabs.filter((tab) => !removed(tab));
      setOpenTabs(rest);
      if (activeTab && removed(activeTab)) {
        setActiveTab(rest[Math.min(index, rest.length - 1)] ?? null);
      }
      if (rest.length === 0) {
        setTaskTabs((current) => current.filter((item) => item !== "files"));
        setActiveTask((current) => (current === "files" ? "terminal" : current));
      }
    },
    [openTabs, activeTab],
  );

  const closeTab = useCallback(
    (tab: Tab) => {
      const match = (item: Tab) => sameTabForClose(item, tab);
      const index = openTabs.findIndex(match);
      if (index === -1) return;
      const rest = openTabs.filter((item) => !match(item));
      setOpenTabs(rest);
      // 关掉的是当前标签时，焦点落到它右边那个（没有就往左退一格）
      if (activeTab && match(activeTab)) {
        setActiveTab(rest[Math.min(index, rest.length - 1)] ?? null);
      }
      if (rest.length === 0) {
        setTaskTabs((current) => current.filter((item) => item !== "files"));
        setActiveTask((current) => (current === "files" ? "terminal" : current));
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

  /** 标题栏「⋯」菜单：一次关掉全部标签 */
  const closeAllTabs = useCallback(() => {
    setOpenTabs([]);
    setActiveTab(null);
    setTaskTabs((current) => current.filter((item) => item !== "files"));
    setActiveTask((current) => (current === "files" ? "terminal" : current));
  }, []);

  /** 标题栏「⋯」菜单：只留当前标签 */
  const closeOtherTabs = useCallback(() => {
    if (!activeTab) return;
    setOpenTabs([activeTab]);
  }, [activeTab]);

  const closeTask = useCallback(
    (task: WorkspaceTask) => {
      if (task === "terminal") return;
      if (task === "files" && activeTab) {
        editorRef.current?.closeActiveTab();
        return;
      }
      const index = taskTabs.indexOf(task);
      if (index < 0) return;
      const remaining = taskTabs.filter((item) => item !== task);
      setTaskTabs(remaining);
      if (activeTask === task) {
        setActiveTask(remaining[Math.max(0, index - 1)] ?? "terminal");
      }
    },
    [activeTask, activeTab, taskTabs],
  );

  const toolPaneProps = {
    roots: workspace.roots,
    activeRoot: root,
    visible,
    filesVisible,
    changesVisible,
    selected: activeTab?.kind === "file" ? activeTab.path : null,
    gitByRoot,
    gitTargets: wtMap,
    gitMarks: git.marks,
    gitReady,
    onSelectFile: openFile,
    onOpenInBrowser: openInBrowser,
    onFormatFile: formatFile,
    onOpenDiff: openDiff,
    onOpenMatch: openMatch,
    onPickWorktree: pickWorktree,
    sessions: terminalSessions,
    onOpenTerminal: openTerminalAt,
    onBeforeReplace: saveAllEdits,
    onAfterReplace: reloadAfterReplace,
    onBeforeRename: saveAllEdits,
    onEntryRenamed: renameOpenTabs,
    onEntryDeleted: dropOpenTabs,
    onRequestCloseTab: () => editorRef.current?.closeActiveTab(),
    filesReveal,
  };
  const activeFilePath = activeTab?.kind === "file" ? activeTab.path : null;
  const filePreviewAvailable =
    activeFilePath !== null && /\.(?:md|mdx|mdc|markdown|html|htm|svg)$/i.test(activeFilePath);
  const railTool = activeTool;

  return (
    <div className={visible ? "relative flex min-h-0 min-w-0 flex-1 flex-col" : "hidden"}>
      <div className="flex h-9 shrink-0 items-center border-b border-line bg-panel">
        <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto px-2">
          {taskTabs.map((task) => {
            const toolInfo = RIGHT_TOOLS.find((item) => item.id === task);
            const label =
              task === "terminal"
                ? "终端 / 对话"
                : task === "files"
                  ? activeTab
                    ? `${tabName(activeTab)}${activeTab.kind === "diff" ? " · 差异" : ""}`
                    : "文件"
                  : toolInfo?.label ?? task;
            return (
              <div
                key={task}
                className={`flex h-7 shrink-0 items-center rounded ${activeTask === task ? "bg-active text-fg" : "text-fg-dim hover:bg-hover"}`}
              >
                <button
                  type="button"
                  onClick={() => setActiveTask(task)}
                  title={label}
                  className="flex max-w-[220px] items-center gap-1.5 py-1 pl-2.5 text-[11px]"
                >
                  {toolInfo && <toolInfo.Icon className="h-3.5 w-3.5 shrink-0" />}
                  <span className="truncate">{label}</span>
                </button>
                {task !== "terminal" && (
                  <button
                    type="button"
                    onClick={() => closeTask(task)}
                    title={task === "files" ? "关闭文件视图" : `关闭${label}`}
                    className="mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-faint hover:bg-hover hover:text-danger"
                  >
                    <span aria-hidden="true">×</span>
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <div className="flex h-full shrink-0 items-center gap-1 px-2">
          {activeTask === "files" && filePreviewAvailable && (
            <button
              type="button"
              onClick={() => editorRef.current?.togglePreview()}
              title="切换预览"
              aria-label="切换预览"
              className="flex h-6 w-6 items-center justify-center rounded text-fg-dim hover:bg-hover hover:text-fg"
            >
              <IconEye className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
      <SplitPane
        initial={76}
        min={48}
        max={90}
        resetOnDoubleClick
        secondCollapsed={rightCollapsed || !taskHasSidebar || leftFullscreen || rightFullscreen}
        animateCollapse
        collapsedSecondWidth={leftFullscreen || rightFullscreen ? 0 : RAIL_WIDTH}
        first={
          <div className="relative flex min-h-0 min-w-0 flex-1">
            <div className={activeTask === "terminal" ? "flex min-h-0 min-w-0 flex-1" : "hidden"}>
              <div className="h-full min-w-0 flex-1">
                <TerminalPane
                  root={root}
                  roots={workspace.roots}
                  visible={visible && activeTask === "terminal"}
                  ref={setTerminalHandle}
                  fullscreen={leftFullscreen}
                  onToggleFullscreen={onToggleLeftFullscreen}
                  onSessionsReport={setTerminalSessions}
                  onOpenFile={openTerminalFile}
                />
              </div>
            </div>
            <div className={activeTask === "files" ? "flex min-h-0 min-w-0 flex-1" : "hidden"}>
              <div className="h-full min-w-0 flex-1">
                <EditorPane
                  ref={setEditorHandle}
                  hideTabStrip
                  root={root}
                  roots={pollRoots}
                  visible={visible && activeTask === "files"}
                  tabs={openTabs}
                  active={activeTab}
                  gitMarks={git.marks}
                  onActivate={setActiveTab}
                  onClose={closeTab}
                  onReorder={reorderTabs}
                  onCloseAll={closeAllTabs}
                  onCloseOthers={closeOtherTabs}
                  onNewUntitled={newUntitled}
                  onPatchTab={patchOpenTab}
                  onOpenPath={openFile}
                  onRevealInFiles={revealInFiles}
                  fullscreen={rightFullscreen}
                  onToggleFullscreen={onToggleRightFullscreen}
                  onSendToTerminal={insertToTerminal}
                  onSendToAssistant={insertToAssistant}
                  onOpenSettings={onOpenSettings}
                />
              </div>
            </div>
            <div className={activeTask === "browser" ? "flex min-h-0 min-w-0 flex-1" : "hidden"}>
              <div className="h-full min-w-0 flex-1">
                <BrowserPane
                  root={root}
                  request={browserFile}
                  fullscreen={rightFullscreen}
                  onToggleFullscreen={onToggleRightFullscreen}
                />
              </div>
            </div>
            <div className={activeTask === "remote" ? "flex min-h-0 min-w-0 flex-1" : "hidden"}>
              <div className="h-full min-w-0 flex-1">
                <RemotePane
                  sidebarTarget={activeTool === "remote" ? taskSidebarTarget : null}
                  onOpenContent={() => openTask("remote")}
                  fullscreen={rightFullscreen}
                  onToggleFullscreen={onToggleRightFullscreen}
                />
              </div>
            </div>
            <div className={activeTask === "database" ? "flex min-h-0 min-w-0 flex-1" : "hidden"}>
              <div className="h-full min-w-0 flex-1">
                <DatabasePane
                  sidebarTarget={activeTool === "database" ? taskSidebarTarget : null}
                  onOpenContent={() => openTask("database")}
                  fullscreen={rightFullscreen}
                  onToggleFullscreen={onToggleRightFullscreen}
                />
              </div>
            </div>
          </div>
        }
        second={
          <div className="flex min-h-0 min-w-0 flex-1">
            <div className={rightOpen ? "flex min-h-0 min-w-0 flex-1 overflow-hidden" : "hidden"} inert={!rightOpen}>
              {activeTool === "remote" || activeTool === "database" ? (
                <div ref={setTaskSidebarTarget} className="h-full w-full min-w-0" />
              ) : activeTool === "preview" ? (
                <PreviewPane
                  root={root}
                  visible={visible && rightOpen}
                  fullscreen={rightFullscreen}
                  onToggleFullscreen={onToggleRightFullscreen}
                />
              ) : activeTool === "deploy" ? (
                <DeployPane
                  root={root}
                  visible={visible && rightOpen}
                  fullscreen={rightFullscreen}
                  onToggleFullscreen={onToggleRightFullscreen}
                />
              ) : activeTool !== "browser" ? (
                <div className="h-full w-full min-w-0">
                  <ToolPane tool={tool} {...toolPaneProps} />
                </div>
              ) : null}
            </div>
            <ToolRail
              active={railTool}
              changed={changedCount}
              visible={toolVisible}
              onPick={pickTool}
              rightOpen={rightOpen}
              onToggleRight={toggleRight}
              onBlankClick={onBlankClick}
            />
          </div>
        }
      />
    </div>
  );
}
