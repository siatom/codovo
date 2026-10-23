import { useCallback, useEffect, useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { WorkspaceDialog } from "./components/WorkspaceDialog";
import { Sidebar, readSidebarCollapsed, saveSidebarCollapsed } from "./components/Sidebar";
import {
  WorkspacePane,
  type Fullscreen,
  type WorkspaceHandles,
} from "./components/WorkspacePane";
import { WorkspaceEmpty } from "./components/WorkspaceEmpty";
import { SettingsDialog } from "./components/SettingsDialog";
import { TitleBar } from "./components/TitleBar";
import { Toast } from "./components/Toast";
import { AppAssistantDrawer, type AppAssistantDrawerHandle } from "./components/AppAssistantDrawer";
import {
  AgentSessionProvider,
  useDropAgentSession,
  useOpenSessionAt,
} from "./lib/agent-session";
import { AttentionProvider, useDropAttention } from "./lib/attention";
import { ActivityProvider, useDropActivity, useTouchActivity } from "./lib/activity";
import { RemoteHostsProvider } from "./lib/remote-hosts";
import { DbConnectionsProvider } from "./lib/db-connections";
import {
  respondAppAgent,
  runAppAgentTool,
  takeAppAgentRequest,
  type AppAgentContext,
} from "./lib/app-agent";
import {
  respondPreviewAgent,
  runPreviewTool,
  takePreviewAgentRequest,
} from "./lib/preview-agent";
import { useTheme } from "./lib/theme";
import {
  isPathInside,
  onFilesChanged,
  pathKey,
  pathsExist,
  pathsPresent,
  pickFolder,
  pickOpenPath,
  workspaceActivate,
  workspaceClose,
  workspaceRegister,
  samePath,
  toDisplayPath,
} from "./lib/fs";
import {
  clearLastWorkspaceId,
  dropWorkspace,
  folderName,
  migrateWorkspaces,
  newWorkspaceId,
  onWorkspacesChanged,
  readLastWorkspaceId,
  saveLastWorkspaceId,
  saveWorkspace,
  type Workspace,
} from "./lib/workspaces";
import { clearSession } from "./lib/session";
import {
  useSettings,
  FONT_SIZE_MIN,
  FONT_SIZE_MAX,
  DEFAULT_EDITOR_FONT_SIZE,
} from "./lib/settings";
import { matchesShortcut, isShortcutRecording } from "./lib/shortcuts";
import { isTypingTarget } from "./lib/dom";
import { beginLayoutAnimation } from "./lib/layout-motion";
import type { EditorLocation } from "./lib/types";
import { hideToTray, onCloseRequested, quitApp } from "./lib/window";

/** 新建 / 编辑工作区对话框的状态 */
type DialogState = { mode: "create" } | { mode: "edit"; workspace: Workspace };

/**
 * 文件所在目录。路径分隔符两种都认；盘符根（`C:`）补回分隔符，
 * 否则 `C:\a.txt` 会得到 `C:`，后端不把它当目录。
 */
function parentDir(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  if (index <= 0) return "";
  const dir = trimmed.slice(0, index);
  return /^[A-Za-z]:$/.test(dir) ? `${dir}\\` : dir;
}

/**
 * 应用助手桥的轮询间隔。后端 MCP 子进程只能把请求写成文件，没有推送通道，
 * 所以这里轮询——每轮就是读一个小文件，代价可以忽略。
 */
const APP_AGENT_POLL_MS = 500;

/**
 * 一个窗口，多个工作区并行。
 *
 * 每个打开的工作区各挂一个 `WorkspacePane` 实例，非当前的藏着不卸载——切工作区就是
 * 切 `visible`，于是终端会话、智能体对话、编辑器标签、文件树展开态全都原样保留，
 * 后台的进程也照跑。这正是和传统 IDE「一个窗口一个工作区」最大的不同。
 *
 * 工作区是**一对多**的：一个工作区可以挂多个工作目录（`workspace.roots`），文件树把它们
 * 并列显示；终端 / 变更 / 智能体这些一次只认一个根，跟 `workspace.activeRoot` 走。
 *
 * 侧栏那份 `workspaces` 是「用过的工作区」，`opened` 是其中已经打开的那些。
 */
function Shell() {
  /** 全部工作区，最近创建/打开的排在最前 */
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  /** 已经打开的工作区 id（各自有工作区实例），按打开顺序 */
  const [opened, setOpened] = useState<string[]>([]);
  /** 当前显示哪个工作区 */
  const [activeId, setActiveId] = useState<string | null>(null);
  const [booting, setBooting] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * 目录已被删掉 / 换盘的工作区根（按 `pathKey` 存）。侧栏据此把这类工作区标出来——
   * 它点开必然失败（`workspace_activate` 只认 `is_dir`），先给个视觉预警。
   */
  const [missingRoots, setMissingRoots] = useState<Set<string>>(new Set());
  /** 右下角操作反馈条。目前只报「打开失效工作区失败」这类错误 */
  const [toast, setToast] = useState<string | null>(null);
  /** 全屏区域。会连带隐藏侧边栏，属于窗口级布局，所以不放工作区实例里 */
  const [fullscreen, setFullscreen] = useState<Fullscreen>("none");
  /** 新建 / 编辑工作区的对话框 */
  const [dialog, setDialog] = useState<DialogState | null>(null);
  /** 等着确认移除的工作区；非空时弹确认框 */
  const [pendingRemove, setPendingRemove] = useState<Workspace | null>(null);
  /**
   * 侧边栏收起 / 展开。状态挂在这里而不是 Sidebar 内部：`app.toggleSidebar`（Ctrl+B）
   * 在窗口级分发，够不着组件内部 state；落盘仍是 sessionStorage（窗口级偏好）。
   */
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed);
  /**
   * 设置面板是否打开。同样挂在窗口级：`app.settings`（Ctrl+,）要能打开它，
   * 面板本体仍渲染在 Sidebar 里（它的入口按钮在那里）。
   */
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 系统拖放文件 / 文件夹进窗口时显示遮罩 */
  const [dropActive, setDropActive] = useState(false);
  /**
   * 跨工作区打开文件的请求队列：App 找到（或新建）目标工作区后，把路径交给那个实例。
   * 用数组而不是单槽：一次拖进多个文件、或连续按 Ctrl+O 时，后一个不能覆盖前一个。
   * nonce 让同一条路径连点两次也能再执行一次，处理完按 nonce 移除。
   */
  const [openRequests, setOpenRequests] = useState<
    Array<{
      workspaceId: string;
      path: string;
      nonce: number;
    }>
  >([]);
  const openRequestNonceRef = useRef(0);
  const enqueueOpenRequest = useCallback((workspaceId: string, path: string) => {
    const nonce = (openRequestNonceRef.current += 1);
    setOpenRequests((current) => [...current, { workspaceId, path, nonce }]);
  }, []);

  /** 关工作区时要把它那份会话状态一起丢掉，下次打开是干净的 */
  const dropAgentSession = useDropAgentSession();
  /** 同理，丢掉它那份「等用户」标记 */
  const dropAttention = useDropAttention();
  /** 工作区从列表里移除时，丢掉它那份「最近活动」记录（侧栏排序依据） */
  const dropActivity = useDropActivity();
  /** 新建工作区时记一次活动，让它立刻排到非置顶组最前 */
  const touchActivity = useTouchActivity();
  /** 给还没切过去的工作区「打开某条会话」用（侧栏的「在等用户」标记） */
  const openSessionAt = useOpenSessionAt();

  const { settings, update, reset, resetSection } = useSettings();
  // 启动恢复只在挂载时判定一次：之后用户在设置里改开关，不该影响本次启动
  const restoreWorkspaceRef = useRef(settings.restoreWorkspace);
  /**
   * 窗口级快捷键分发要读「此刻」的键位与字号，而监听只注册一次，所以走 ref。
   * （编辑器命令不在这里分发，见 components/EditorPane.tsx 的 onPaneKeyDown）
   */
  const shortcutsRef = useRef(settings.shortcuts);
  shortcutsRef.current = settings.shortcuts;
  const editorFontSizeRef = useRef(settings.editorFontSize);
  editorFontSizeRef.current = settings.editorFontSize;
  const sidebarCollapsedRef = useRef(sidebarCollapsed);
  sidebarCollapsedRef.current = sidebarCollapsed;
  /** Ctrl+O 的窗口级处理。定义在后面的 chooseFile 经 ref 兜住，监听只注册一次 */
  const chooseFileRef = useRef<() => void>(() => {});
  const { preference: themePreference, setPreference: setTheme } = useTheme();
  /** 关窗口的确认框：开着工作区、又还没记住选择时才弹 */
  const [closePrompt, setClosePrompt] = useState(false);
  /** 应用助手要执行破坏性操作时弹的确认框；非空时显示 */
  const [agentConfirm, setAgentConfirm] = useState<{
    message: string;
    confirmLabel: string;
  } | null>(null);
  /** 上面那个确认框的 resolver；用户点了确认 / 取消后兑现，工具调用据此继续 */
  const agentConfirmRef = useRef<((ok: boolean) => void) | null>(null);
  /** 应用助手抽屉是否展开；面板挂在 App 上——它是窗口级的，不属于任何工作区实例 */
  const [assistantOpen, setAssistantOpen] = useState(false);
  /** 助手抽屉的句柄：编辑器浮窗要把位置引用塞进它的输入框 */
  const assistantRef = useRef<AppAssistantDrawerHandle>(null);

  const activeWorkspace = workspaces.find((item) => item.id === activeId) ?? null;
  const activeRoot = activeWorkspace?.activeRoot ?? null;

  /**
   * 几个 handle 与工作区状态的最新快照。切工作区、关工作区、磁盘事件回调都要读「此刻」
   * 的值，而不是注册那一刻闭包里的——放 ref 里最省事，也免得 effect 反复重注册。
   */
  const workspacesRef = useRef<Workspace[]>([]);
  workspacesRef.current = workspaces;
  const openedRef = useRef<string[]>([]);
  openedRef.current = opened;
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;

  /**
   * 关窗口那一下已经被后端拦下了（`prevent_close`），是收进托盘还是真退出由这儿说了算。
   * 工作区列表和设置都变得勤，用 ref 兜住最新值、监听只注册一次——每次变化都重注册
   * 会跟卸载抢时间，回调可能打到已经被清的监听上。
   */
  const onCloseRef = useRef<() => void>(() => {});
  onCloseRef.current = () => {
    if (opened.length === 0) {
      // 没工作区就别留个空壳进程在后台
      void quitApp();
    } else if (settings.closeToTray) {
      void hideToTray();
    } else {
      setClosePrompt(true);
    }
  };

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    void onCloseRequested(() => onCloseRef.current()).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  /**
   * 工作区 id -> 该工作区的两个 handle。侧栏的 AI CLI 命令、编辑器浮窗得打到**当前工作区**
   * 的实例上，而 handle 是各实例自己的
   */
  const handlesRef = useRef(new Map<string, WorkspaceHandles>());
  const onHandles = useCallback((workspaceId: string, handles: WorkspaceHandles) => {
    handlesRef.current.set(workspaceId, handles);
  }, []);

  /**
   * 侧栏底部点了某条 CLI 历史会话：新开一个终端标签跑 resume，不动正在用的那个。
   * `title`（被恢复会话的标题）作新标签的标题
   */
  const resumeSession = useCallback((command: string, title: string) => {
    if (!activeIdRef.current) return;
    handlesRef.current.get(activeIdRef.current)?.terminal?.runInNewSession(command, title);
  }, []);

  /** 编辑器浮窗「送给助手」：展开抽屉并把位置引用插进它的输入框 */
  const openAssistantAt = useCallback((location?: EditorLocation) => {
    setAssistantOpen(true);
    if (location) {
      // 面板刚展开时输入框可能还没就绪，由它自己的 pending 兜住（见 AgentPane.insertRef）
      assistantRef.current?.insertRef(location);
    }
  }, []);

  /**
   * 打开 / 切换工作区。已经打开过的就只切过去，不重建实例。
   *
   * 每次都要 activate：后端的目录监听是一组根的**整体替换**，只跟当前工作区——
   * 切过去时不重新登记，新工作区的根就没人盯着。
   */
  const openWorkspace = useCallback(async (workspace: Workspace): Promise<Workspace | null> => {
    try {
      const resolved = await workspaceActivate(workspace.roots);
      // 活动根要落到 canonical 后的路径上，否则后端按它查白名单会落空
      const index = workspace.roots.findIndex((root) => samePath(root, workspace.activeRoot));
      const next: Workspace = {
        ...workspace,
        roots: resolved,
        activeRoot: resolved[index >= 0 ? index : 0] ?? workspace.activeRoot,
      };
      setWorkspaces(saveWorkspace(next));
      setOpened((current) => (current.includes(next.id) ? current : [...current, next.id]));
      setActiveId(next.id);
      saveLastWorkspaceId(next.id);
      setNotice(null);
      // 返回 canonical 之后的工作区：调用方（新建对话）要拿它落定的活动根当会话状态的 key
      return next;
    } catch (reason) {
      // 用 Toast 而不是 notice：notice 只在「一个工作区都没开」的空态里显示，
      // 而点开失效工作区多半发生在已经有工作区开着的时候，那种情况 notice 是看不见的
      setToast(`这个目录打不开了：${reason}`);
      return null;
    }
  }, []);

  /**
   * 侧栏点了「在等用户」的提示：切到那个工作区，并选中对应的标签 / 会话。
   * `target` 形如 `term:<标签 id>` / `agent:<会话 id>`（见 lib/attention）。
   * 终端标签直接聚焦；助手会话则展开右栏抽屉并选中它。
   */
  const focusAttention = useCallback(
    async (workspace: Workspace, target: string) => {
      let root = workspace.activeRoot;
      if (activeIdRef.current !== workspace.id) {
        const next = await openWorkspace(workspace);
        // 目录打不开时 openWorkspace 已经提示过，这里不再往下走
        if (!next) return;
        root = next.activeRoot;
      }
      if (target.startsWith("term:")) {
        handlesRef.current.get(workspace.id)?.terminal?.focusSession(Number(target.slice(5)));
      } else if (target.startsWith("agent:")) {
        // 请求挂在会话状态里，面板展开后会自己消费（见 AgentPane 的 requestedId）
        openSessionAt(root, target.slice(6));
        setAssistantOpen(true);
      }
    },
    [openWorkspace, openSessionAt],
  );

  /** 「新建工作区」提交：新建一个工作区并打开它 */
  const createWorkspace = useCallback(
    async (value: { name: string; roots: string[] }) => {
      setDialog(null);
      // 新建是有意动作，记一次活动，让它立刻排到非置顶组最前（否则活动为 0 会沉到末尾）
      for (const root of value.roots) touchActivity(root);
      await openWorkspace({
        id: newWorkspaceId(),
        name: value.name,
        roots: value.roots,
        activeRoot: value.roots[0],
      });
    },
    [openWorkspace, touchActivity],
  );

  /**
   * 把一组文件夹作为工作区打开。同一目录已经在某个工作区里时只切过去，
   * 不重复创建；多个文件夹按现有规则合成一个多根工作区（和新建对话框一致）。
   */
  const openFolders = useCallback(
    async (roots: string[]) => {
      const unique: string[] = [];
      const seen = new Set<string>();
      for (const root of roots) {
        const key = pathKey(root);
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(root);
      }
      if (unique.length === 0) return;

      const existing =
        unique.length === 1
          ? workspacesRef.current.find((ws) => ws.roots.some((root) => samePath(root, unique[0])))
          : workspacesRef.current.find((ws) =>
              unique.every((root) => ws.roots.some((item) => samePath(item, root))),
            );
      if (existing) {
        await openWorkspace(existing);
        return;
      }

      // 拖入 / 选择是明确动作，记一次活动，让它排到非置顶组最前
      touchActivity(unique[0]);
      await openWorkspace({
        id: newWorkspaceId(),
        name: folderName(unique[0]),
        roots: unique,
        activeRoot: unique[0],
      });
    },
    [openWorkspace, touchActivity],
  );

  /**
   * 打开任意路径上的一个文件：
   * - 落在某个已记录工作区的根里 → 切到那个工作区再开标签；
   * - 不在任何工作区里 → 以文件所在目录为根建 / 复用临时工作区后打开。
   *
   * 沙箱没有放宽：新工作区的根会经 `workspace_activate` 登记，读写仍由后端校验。
   * 文件已被删掉时只提示，不改变当前工作区。
   */
  const openFileAnywhere = useCallback(
    async (path: string) => {
      if (!path) return;
      try {
        const [present] = await pathsPresent([path]);
        if (!present) {
          setToast(`文件不存在：${toDisplayPath(path)}`);
          return;
        }
      } catch {
        // 存在性校验失败不拦着打开，真正的错误由读盘给出
      }

      const owner = workspacesRef.current.find((ws) =>
        ws.roots.some((root) => isPathInside(path, root)),
      );
      if (owner) {
        if (activeIdRef.current !== owner.id) {
          const next = await openWorkspace(owner);
          if (!next) return;
        }
        enqueueOpenRequest(owner.id, path);
        return;
      }

      const dir = parentDir(path);
      if (!dir) {
        setToast(`打不开这个路径：${toDisplayPath(path)}`);
        return;
      }
      const reusable = workspacesRef.current.find((ws) =>
        ws.roots.some((root) => samePath(root, dir)),
      );
      if (reusable) {
        if (activeIdRef.current !== reusable.id) {
          const next = await openWorkspace(reusable);
          if (!next) return;
        }
        enqueueOpenRequest(reusable.id, path);
        return;
      }

      touchActivity(dir);
      const next = await openWorkspace({
        id: newWorkspaceId(),
        name: folderName(dir),
        roots: [dir],
        activeRoot: dir,
      });
      if (!next) return;
      enqueueOpenRequest(next.id, path);
    },
    [openWorkspace, touchActivity, enqueueOpenRequest],
  );

  /** 全局 Ctrl+O：没有工作区时也能选文件，选完由 `openFileAnywhere` 决定落到哪 */
  const chooseFile = useCallback(async () => {
    try {
      const target = await pickOpenPath();
      if (target !== null) await openFileAnywhere(target);
    } catch (reason) {
      setToast(`选择文件失败：${reason}`);
    }
  }, [openFileAnywhere]);
  chooseFileRef.current = chooseFile;

  /**
   * 欢迎页的主入口「打开文件夹」：直接挑目录当工作区打开，不用先经过新建对话框。
   * 选多个目录时按现有规则合成一个多根工作区（和拖入一致）。
   */
  const openFolderFromWelcome = useCallback(async () => {
    try {
      const picked = await pickFolder();
      if (picked.length > 0) await openFolders(picked);
    } catch (reason) {
      setToast(`选择文件夹失败：${reason}`);
    }
  }, [openFolders]);

  /** 目标工作区处理完单文件请求后按 nonce 移除，免得实例重挂载时又打开一次 */
  const handleOpenRequestHandled = useCallback((nonce: number) => {
    setOpenRequests((current) => current.filter((item) => item.nonce !== nonce));
  }, []);

  /**
   * 「编辑工作区」提交：改名字与工作目录。
   *
   * 开着的工作区要顺手把新根登记进后端，否则文件树读不到；但**只有当前工作区**才整体
   * 换目录监听，后台工作区只登记（`workspace_register`），免得监听被抢走。
   */
  const applyEdit = useCallback(
    async (workspace: Workspace, value: { name: string; roots: string[] }) => {
      setDialog(null);
      const index = value.roots.findIndex((root) => samePath(root, workspace.activeRoot));
      const next: Workspace = {
        ...workspace,
        name: value.name,
        roots: value.roots,
        activeRoot: value.roots[index >= 0 ? index : 0] ?? workspace.activeRoot,
      };

      if (openedRef.current.includes(workspace.id)) {
        try {
          const resolved =
            activeIdRef.current === workspace.id
              ? await workspaceActivate(next.roots)
              : await workspaceRegister(next.roots);
          next.roots = resolved;
          next.activeRoot = resolved[index >= 0 ? index : 0] ?? next.activeRoot;
        } catch (reason) {
          setNotice(`工作区改不动了：${reason}`);
        }
      }
      setWorkspaces(saveWorkspace(next));
    },
    [],
  );

  /** 关闭一个已打开的工作区：收它的终端与 opencode 进程、丢掉它的界面实例 */
  const closeWorkspace = useCallback(
    (workspace: Workspace) => {
      void workspaceClose(workspace.roots).catch(() => {});
      // 每个根在会话状态里各占一份，都要丢
      for (const root of workspace.roots) {
        dropAgentSession(root);
        dropAttention(root);
      }
      // 工作区实例要卸载了，它那份标签会话不再有用；下次打开从空标签开始
      clearSession(workspace.id);
      handlesRef.current.delete(workspace.id);
      // 还没来得及消费的打开请求跟着作废，别让队首永远卡在一个已关闭的工作区上
      setOpenRequests((current) => current.filter((item) => item.workspaceId !== workspace.id));

      const rest = openedRef.current.filter((id) => id !== workspace.id);
      setOpened(rest);
      if (activeIdRef.current !== workspace.id) return;

      // 关的就是当前这个：切到还开着的第一个，没有就回到空态
      const nextId = rest[0] ?? null;
      setActiveId(nextId);
      setFullscreen("none");
      if (nextId) {
        saveLastWorkspaceId(nextId);
        const nextWorkspace = workspacesRef.current.find((item) => item.id === nextId);
        // 当前工作区换人了，后端的目录监听也得跟着挪
        if (nextWorkspace) void workspaceActivate(nextWorkspace.roots).catch(() => {});
      } else {
        // 关到空：把「上次的工作区」清掉，让「一个都没开」这个状态也跨启动保留。
        // 用户特意把工作区全关掉再退出，下次启动就该还是空态，不该替他把最后一个又开回来。
        // 工作区本身还在列表里（没走 dropWorkspace），侧栏点一下就能重新打开。
        clearLastWorkspaceId();
      }
    },
    [dropAgentSession, dropAttention],
  );

  /**
   * 从列表里移除一个工作区。只动 Codovo 自己的记录，不碰磁盘上的目录。
   * 它还开着的话一并关掉——不然终端和 opencode 会一直在后台跑，用户却再也看不到。
   */
  const removeWorkspace = useCallback(
    (workspace: Workspace) => {
      if (openedRef.current.includes(workspace.id)) closeWorkspace(workspace);
      // 工作区没了，它那份「最近活动」记录也没用了（排序依据），一并清掉
      for (const root of workspace.roots) dropActivity(root);
      // 没打开过的工作区不会走 closeWorkspace，这里补一次会话清理
      clearSession(workspace.id);
      setWorkspaces(dropWorkspace(workspace.id));
    },
    [closeWorkspace, dropActivity],
  );

  /** 置顶 / 取消置顶。只改记录里的标记，「置顶的排最前」由侧边栏渲染时排序实现 */
  const togglePin = useCallback((workspace: Workspace) => {
    setWorkspaces(saveWorkspace({ ...workspace, pinned: !workspace.pinned }));
  }, []);

  /** 右栏（编辑器 / 浏览器）全屏，按钮挂在这两个面板的标题栏上 */
  const toggleRightFullscreen = useCallback(
    () => setFullscreen((area) => (area === "right" ? "none" : "right")),
    [],
  );

  /** 左侧终端 / 智能体全屏。两者是同一列，共用这一个开关 */
  const toggleLeftFullscreen = useCallback(
    () => setFullscreen((area) => (area === "left" ? "none" : "left")),
    [],
  );

  const exitFullscreen = useCallback(() => setFullscreen("none"), []);

  /** 收起 / 展开侧边栏：状态在 App 上，落盘一并做（Ctrl+B 与侧栏里的按钮共用） */
  const applySidebarCollapsed = useCallback((next: boolean) => {
    // 侧栏宽度动画会连续改变终端宽度，先标记一下，让终端等动画结束再 fit
    beginLayoutAnimation();
    setSidebarCollapsed(next);
    saveSidebarCollapsed(next);
  }, []);

  /**
   * 窗口级快捷键分发：打开设置、切换侧边栏、编辑器字号缩放。这几条不属于任何编辑器实例
   * （字号是所有编辑器共用的设置），也不是终端该处理的键，所以挂在窗口的**捕获阶段**。
   *
   * 三道闸门保证不抢键盘：
   * 1. 只认这几个 id 的键位（白名单）——Ctrl+S / Ctrl+F 这些编辑器命令一律由
   *    EditorPane 在自己区域内分发，终端里的 Ctrl+C/V/W 完全不受影响；
   * 2. 焦点在终端或输入框里时整条放行（`isTypingTarget`）——Ctrl+B 在 shell 里是
   *    readline 的光标左移、Ctrl+PageUp/Down 也被 TUI 用着，宿主抢了前台程序就没法用；
   * 3. 正在录制键位时整条让路（见 lib/shortcuts.ts 的 isShortcutRecording）。
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const shortcuts = shortcutsRef.current;
      const zoom = (delta: number) => {
        const current = editorFontSizeRef.current;
        const next = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, current + delta));
        if (next !== current) update({ editorFontSize: next });
      };
      const commands: [string, () => void][] = [
        ["app.settings", () => setSettingsOpen(true)],
        ["app.toggleSidebar", () => applySidebarCollapsed(!sidebarCollapsedRef.current)],
        // Ctrl+O 是窗口级入口：没有打开任何工作区时也要能选文件（选完建临时工作区）。
        // 捕获阶段先吃掉，避免编辑器区域内再弹一次同一个对话框
        ["editor.openFile", () => chooseFileRef.current()],
        ["editor.zoomIn", () => zoom(1)],
        ["editor.zoomOut", () => zoom(-1)],
        ["editor.zoomReset", () => update({ editorFontSize: DEFAULT_EDITOR_FONT_SIZE })],
      ];
      for (const [id, run] of commands) {
        if (!matchesShortcut(event, shortcuts[id])) continue;
        // 录制键位时整条让路（录制控件会自己处理这些按键），终端 / 输入框里同理
        if (isShortcutRecording() || isTypingTarget(event)) return;
        event.preventDefault();
        event.stopPropagation();
        run();
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [applySidebarCollapsed, update]);

  // ---- 应用助手（界面操作智能体）的桥 ----

  /**
   * 应用助手要执行不可逆操作（移除工作区、恢复默认设置）时，工具调用会 await 这里：
   * 弹确认框、等用户点，再把结果兑现回去。工具那边有超时，用户一直不理也不会永远挂着。
   */
  const confirmFromAgent = useCallback(
    (message: string, confirmLabel: string) =>
      new Promise<boolean>((resolve) => {
        // 上一次还没结掉（模型连着调两次）：直接当拒绝，别把 resolver 覆盖掉
        agentConfirmRef.current?.(false);
        agentConfirmRef.current = resolve;
        setAgentConfirm({ message, confirmLabel });
      }),
    [],
  );

  const settleAgentConfirm = useCallback((ok: boolean) => {
    const resolve = agentConfirmRef.current;
    agentConfirmRef.current = null;
    setAgentConfirm(null);
    resolve?.(ok);
  }, []);

  /**
   * 应用助手执行一次工具调用所需的一切。**每次渲染重建**：它读的都是「此刻」的 state
   * 与句柄；而轮询 effect 只挂一次，直接捕获的话拿到的是首帧的旧值，所以经 ref 传进去。
   */
  const appAgentCtxRef = useRef<AppAgentContext | null>(null);
  appAgentCtxRef.current = {
    settings,
    theme: themePreference,
    fullscreen,
    activeWorkspace,
    update,
    setTheme,
    reset,
    resetSection,
    workspaces,
    setWorkspaces,
    openWorkspace,
    removeWorkspace,
    // 右栏模块与展开状态挂在各工作区实例上，按工作区 id 路由到当前那个
    layout: {
      openTool: (id) => handlesRef.current.get(activeIdRef.current ?? "")?.layout?.openTool(id),
      setRightOpen: (open) =>
        handlesRef.current.get(activeIdRef.current ?? "")?.layout?.setRightOpen(open),
    },
    setFullscreen,
    confirm: confirmFromAgent,
  };

  // 常驻轮询：工具调用可能发生在任何时候，不能只在智能体面板可见时才跑
  useEffect(() => {
    let stopped = false;
    let busy = false;
    // 启动时先丢掉上一轮残留的请求：应用崩溃 / 退出时留下的那条此刻已经没有等待者，
    // 执行它只会在界面上莫名其妙弹一个确认框
    void takeAppAgentRequest().catch(() => {});
    const tick = async () => {
      if (stopped || busy) return;
      busy = true;
      try {
        const request = await takeAppAgentRequest();
        const ctx = appAgentCtxRef.current;
        if (!request || !ctx || stopped) return;
        const outcome = await runAppAgentTool(request, ctx);
        await respondAppAgent(request.id, outcome.ok, outcome.text);
      } catch (reason) {
        // 这里失败意味着结果没能写回去，MCP 那边只能等到超时；留个日志方便排查
        console.error("应用助手工具调用失败", reason);
      } finally {
        busy = false;
      }
    };
    const timer = window.setInterval(() => void tick(), APP_AGENT_POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, []);

  /**
   * 预览助手桥：和应用助手同一套（后端 MCP 子进程只能写请求文件），执行的是预览工具。
   * 每条请求自带它所属的工作区路径（后端经 `CODOVO_PREVIEW_ROOT` 注入），
   * 所以这里不依赖「当前活动工作区」——后台工作区的预览助手也能正常执行。
   */
  useEffect(() => {
    let stopped = false;
    let busy = false;
    void takePreviewAgentRequest().catch(() => {});
    const tick = async () => {
      if (stopped || busy) return;
      busy = true;
      try {
        const request = await takePreviewAgentRequest();
        if (!request || stopped) return;
        const outcome = await runPreviewTool(request);
        await respondPreviewAgent(request.id, outcome.ok, outcome.text);
      } catch (reason) {
        console.error("预览助手工具调用失败", reason);
      } finally {
        busy = false;
      }
    };
    const timer = window.setInterval(() => void tick(), APP_AGENT_POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, []);

  /** 侧栏底部的「应用助手」入口：展开右栏抽屉 */
  const openAppAgent = useCallback(() => {
    const workspace = workspacesRef.current.find((item) => item.id === activeIdRef.current);
    if (!workspace) {
      setToast("先打开一个工作区，应用助手要在工作区里跑");
      return;
    }
    setAssistantOpen(true);
  }, []);

  // 启动时恢复上次用的工作区。只恢复**一个**：同时挂起多个工作区意味着一次起好几个
  // shell 和 opencode，用户没点过的不该有这种代价
  useEffect(() => {
    let cancelled = false;
    // 旧版「一个目录一个工作区」的记录在这里就地升级成工作区实体
    const list = migrateWorkspaces();
    setWorkspaces(list);

    // 关掉「启动恢复工作区」就直接进空态；lastWorkspace 记录留着，下次开回来还在
    const lastId = restoreWorkspaceRef.current ? readLastWorkspaceId() : null;
    const last = list.find((item) => item.id === lastId) ?? null;
    if (!last) {
      setBooting(false);
      return;
    }
    void workspaceActivate(last.roots)
      .then((resolved) => {
        if (cancelled) return;
        const index = last.roots.findIndex((root) => samePath(root, last.activeRoot));
        const next: Workspace = {
          ...last,
          roots: resolved,
          activeRoot: resolved[index >= 0 ? index : 0] ?? last.activeRoot,
        };
        setWorkspaces(saveWorkspace(next));
        setOpened([next.id]);
        setActiveId(next.id);
      })
      .catch((reason) => {
        if (cancelled) return;
        // 目录被删了/换盘了，清掉记录回到空态，别让用户每次启动都撞同一个错
        clearLastWorkspaceId();
        setNotice(`上次的工作区打不开了：${reason}`);
      })
      .finally(() => {
        if (!cancelled) setBooting(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // 窗口标题跟着当前工作区走，用户和调试脚本都靠它分辨现在在哪个工作区上。
  // dev 构建额外带个 (dev)：和安装版并存时一眼分得清。标记只放在标题里，
  // 版本号本身保持纯数字——Windows 的 exe 版本资源不接受后缀。
  const activeName = activeWorkspace?.name ?? null;
  useEffect(() => {
    const name = import.meta.env.DEV ? "Codovo (dev)" : "Codovo";
    document.title = activeName ? `${name} — ${activeName}` : name;
  }, [activeName]);

  // 别的窗口（如果还开着）改了工作区列表，本窗口的侧栏跟着更新
  useEffect(() => onWorkspacesChanged(setWorkspaces), []);

  /**
   * 探一遍列表里所有工作目录还在不在，失效的交给侧栏标出来。
   *
   * 目录可能被外部删掉、或盘符换了，用户不点开就不会发现；这里提前探，点开前就能看到预警。
   * 一次批量问后端（`paths_exist` 与 `workspace_activate` 同一判据），不逐个 invoke。
   */
  useEffect(() => {
    const roots = workspaces.flatMap((workspace) => workspace.roots);
    if (roots.length === 0) {
      setMissingRoots(new Set());
      return;
    }
    let cancelled = false;
    void pathsExist(roots).then((flags) => {
      if (cancelled) return;
      const gone = new Set<string>();
      roots.forEach((root, index) => {
        if (!flags[index]) gone.add(pathKey(root));
      });
      setMissingRoots(gone);
    });
    return () => {
      cancelled = true;
    };
  }, [workspaces]);

  /**
   * 打开着的文件被外部改了（终端、git、别的编辑器、智能体写的）就交给编辑器自己判断怎么处理。
   *
   * 只订阅一次、按路径分发：每个路径只喂给**它所属工作区**的编辑器，不然切走的工作区
   * 也会跟着重读一遍。一个工作区可能挂着多个工作目录，落在任意一个根下都算它。
   * 干净标签自动同步、有未保存改动只打冲突标记，见 `EditorPane.handleExternalChanges`。
   */
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    void onFilesChanged((paths) => {
      for (const [id, handles] of handlesRef.current) {
        const workspace = workspacesRef.current.find((item) => item.id === id);
        if (!workspace) continue;
        const mine = paths.filter((path) =>
          workspace.roots.some((root) => isPathInside(path, root)),
        );
        if (mine.length > 0) void handles.editor?.handleExternalChanges(mine);
      }
    }).then((stop) => {
      if (cancelled) stop();
      else unlisten = stop;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  /**
   * 系统拖放。和文件树内部的 HTML5 拖拽是两回事：这里只接窗口级的文件 / 文件夹，
   * 由 Tauri 的 `onDragDropEvent` 送来。
   *
   * 判定目录 / 文件复用后端的 `paths_exist`（只认目录），其余按文件走单文件规则。
   * 多次拖放串行处理：并行调用 `openWorkspace` 会互相抢后端的目录监听。
   */
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    let queue = Promise.resolve();
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "enter" || payload.type === "over") {
          setDropActive(true);
          return;
        }
        if (payload.type === "leave") {
          setDropActive(false);
          return;
        }
        setDropActive(false);
        const dropped = payload.paths;
        if (dropped.length === 0) return;
        queue = queue.then(async () => {
          try {
            const flags = await pathsExist(dropped);
            const folders = dropped.filter((_, index) => flags[index]);
            const files = dropped.filter((_, index) => !flags[index]);
            if (folders.length > 0) await openFolders(folders);
            for (const file of files) await openFileAnywhere(file);
          } catch (reason) {
            setToast(`打开拖入的内容失败：${reason}`);
          }
        });
      })
      .then((stop) => {
        if (cancelled) stop();
        else unlisten = stop;
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [openFileAnywhere, openFolders]);

  // Esc 退出全屏。拿不到焦点在 iframe 里敲的 Esc（跨域事件不会冒出来），那种情况只能用按钮
  useEffect(() => {
    if (fullscreen === "none") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFullscreen("none");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [fullscreen]);

  // 工作区全关了就没有助手可聊，顺手把抽屉收起来，免得下次开工作区时它突然冒出来
  useEffect(() => {
    if (!activeRoot) setAssistantOpen(false);
  }, [activeRoot]);

  // Esc 关掉助手抽屉。焦点在输入框里时不关——那儿的 Esc 是「反悔这次输入」，
  // 顺手把整个面板收掉会让正在写的内容一起没了
  useEffect(() => {
    if (!assistantOpen) return;    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target as HTMLElement | null;
      if (target?.closest?.('[contenteditable="true"], input, textarea')) return;
      setAssistantOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [assistantOpen]);

  if (booting) {
    // 启动期也挂标题栏：系统标题栏已经去掉了，没有它这块窗口就拖不动
    return (
      <div className="flex h-full w-full flex-col overflow-hidden bg-app">
        <TitleBar workspace={null} />
        <div className="flex flex-1 items-center justify-center text-[12px] text-fg-faint">
          正在恢复上次的工作区…
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-app">
      {/* 自绘标题栏横跨整个窗口：窗口按钮固定在右上角，和系统标题栏的位置一致 */}
      <TitleBar workspace={activeName} />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* 没有打开任何工作区时侧栏整块不挂载，欢迎页铺满窗口——底部另给了设置 / 主题入口。
            有工作区后照旧：全屏时藏起来，用 contents 只是让这层壳不参与布局，Sidebar 本身不卸载 */}
        {opened.length > 0 && (
          <div className={fullscreen !== "none" ? "hidden" : "contents"}>
            <Sidebar
              workspaces={workspaces}
              currentId={activeId}
              activeRoot={activeRoot}
              opened={opened}
              missingRoots={missingRoots}
              onSelect={(workspace) => void openWorkspace(workspace)}
              onCreate={() => setDialog({ mode: "create" })}
              onEdit={(workspace) => setDialog({ mode: "edit", workspace })}
              onRemove={setPendingRemove}
              onClose={closeWorkspace}
              onTogglePin={togglePin}
              onResumeSession={resumeSession}
              onFocusAttention={(workspace, target) => void focusAttention(workspace, target)}
              onOpenAppAgent={openAppAgent}
              collapsed={sidebarCollapsed}
              onSetCollapsed={applySidebarCollapsed}
              settingsOpen={settingsOpen}
              onOpenSettings={() => setSettingsOpen(true)}
              onCloseSettings={() => setSettingsOpen(false)}
            />
          </div>
        )}
        {/* 每个打开的工作区挂一个实例：非当前的 hidden 藏着不卸载，切回来是原样 */}
        {opened.map((id) => {
          const workspace = workspaces.find((item) => item.id === id);
          if (!workspace) return null;
          return (
            <WorkspacePane
              key={id}
              workspace={workspace}
              visible={id === activeId}
              fullscreen={fullscreen}
              onToggleRightFullscreen={toggleRightFullscreen}
              onToggleLeftFullscreen={toggleLeftFullscreen}
              onExitFullscreen={exitFullscreen}
              onHandles={onHandles}
              onSendToAssistant={openAssistantAt}
              onOpenSettings={() => setSettingsOpen(true)}
              onOpenFileAnywhere={(path) => void openFileAnywhere(path)}
              openRequests={openRequests}
              onOpenRequestHandled={handleOpenRequestHandled}
            />
          );
        })}
        {opened.length === 0 && (
          <WorkspaceEmpty
            error={notice}
            workspaces={workspaces}
            missingRoots={missingRoots}
            onCreate={() => setDialog({ mode: "create" })}
            onOpen={(workspace) => void openWorkspace(workspace)}
            onOpenFolder={() => void openFolderFromWelcome()}
            onOpenFile={() => void chooseFile()}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        )}
      </div>

      {/* 应用助手抽屉：窗口级，跟着当前工作区换 root；没工作区时不渲染。
          收起只是滑出视口，对话与滚动状态留着，再展开是原样 */}
      <AppAssistantDrawer
        ref={assistantRef}
        open={assistantOpen && activeRoot !== null}
        root={activeRoot}
        onClose={() => setAssistantOpen(false)}
      />

      {/* 没有打开工作区时侧栏不挂载，设置面板改由窗口层渲染：欢迎页底部的入口
          和 Ctrl+, 都要能打开它。有侧栏时仍由 Sidebar 自己渲染，避免出现两个 */}
      {opened.length === 0 && settingsOpen && (
        <SettingsDialog onClose={() => setSettingsOpen(false)} />
      )}

      {dialog && (
        <WorkspaceDialog
          mode={dialog.mode}
          initialName={dialog.mode === "edit" ? dialog.workspace.name : undefined}
          initialRoots={dialog.mode === "edit" ? dialog.workspace.roots : undefined}
          onCancel={() => setDialog(null)}
          onSubmit={(value) => {
            if (dialog.mode === "create") void createWorkspace(value);
            else void applyEdit(dialog.workspace, value);
          }}
          onRemove={
            dialog.mode === "edit"
              ? () => {
                  const target = dialog.workspace;
                  setDialog(null);
                  setPendingRemove(target);
                }
              : undefined
          }
        />
      )}

      {/* 移除工作区不可撤销（工作区配置会一起没），走自研确认框 */}
      {pendingRemove && (
        <ConfirmDialog
          message={`从列表里移除工作区「${pendingRemove.name}」？只去掉 Codovo 里的记录，不会动磁盘上的文件夹。`}
          confirmLabel="移除"
          onConfirm={() => {
            removeWorkspace(pendingRemove);
            setPendingRemove(null);
          }}
          onCancel={() => setPendingRemove(null)}
        />
      )}

      {/* 应用助手要执行不可逆操作（移除工作区、恢复默认设置）时的确认框。
          工具调用会一直等着这个结果，所以确认 / 取消都要兑现 resolver */}
      {agentConfirm && (
        <ConfirmDialog
          message={agentConfirm.message}
          confirmLabel={agentConfirm.confirmLabel}
          onConfirm={() => settleAgentConfirm(true)}
          onCancel={() => settleAgentConfirm(false)}
        />
      )}

      {closePrompt && (
        <ConfirmDialog
          message={`还有 ${opened.length} 个工作区开着，终端与智能体仍在后台运行。`}
          confirmLabel="退出程序"
          cancelLabel="最小化到托盘"
          checkboxLabel="下次不再询问，直接最小化到托盘"
          onConfirm={(remember) => {
            if (remember) update({ closeToTray: true });
            setClosePrompt(false);
            void quitApp();
          }}
          onCancel={(remember) => {
            if (remember) update({ closeToTray: true });
            setClosePrompt(false);
            void hideToTray();
          }}
          // 按 Esc / 点遮罩是「反悔」：只收起弹窗，窗口、终端、智能体都不动
          onDismiss={() => setClosePrompt(false)}
        />
      )}

      {/* 系统拖放遮罩：只做视觉反馈，不拦截事件（pointer-events-none），松手后由监听器处理 */}
      {dropActive && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-app/70 backdrop-blur-sm">
          <div className="rounded-xl border border-dashed border-accent-strong bg-raised px-10 py-7 text-center shadow-xl">
            <p className="text-[14px] font-medium text-fg">松开以打开</p>
            <p className="mt-1.5 text-[12px] text-fg-faint">
              文件夹会作为工作区打开，文件会直接进入编辑器
            </p>
          </div>
        </div>
      )}

      {/* 操作反馈条：不打断操作地飘在右下角，几秒后自己消失 */}
      {toast && <Toast message={toast} onClose={() => setToast(null)} />}
    </div>
  );
}

export default function App() {
  return (
    <AgentSessionProvider>
      <AttentionProvider>
        <ActivityProvider>
          <RemoteHostsProvider>
            <DbConnectionsProvider>
              <Shell />
            </DbConnectionsProvider>
          </RemoteHostsProvider>
        </ActivityProvider>
      </AttentionProvider>
    </AgentSessionProvider>
  );
}
