import { useCallback, useEffect, useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { WorkspaceDialog } from "./components/WorkspaceDialog";
import { Sidebar } from "./components/Sidebar";
import {
  WorkspacePane,
  type Fullscreen,
  type WorkspaceHandles,
} from "./components/WorkspacePane";
import { WorkspaceEmpty } from "./components/WorkspaceEmpty";
import { AgentSessionProvider, useDropAgentSession, useNewChatAt } from "./lib/agent-session";
import { RemoteHostsProvider } from "./lib/remote-hosts";
import { DbConnectionsProvider } from "./lib/db-connections";
import {
  isPathInside,
  onFilesChanged,
  workspaceActivate,
  workspaceClose,
  workspaceRegister,
  samePath,
} from "./lib/fs";
import {
  clearLastWorkspaceId,
  dropWorkspace,
  migrateWorkspaces,
  newWorkspaceId,
  onWorkspacesChanged,
  readLastWorkspaceId,
  reorderWorkspaces,
  saveLastWorkspaceId,
  saveWorkspace,
  type Workspace,
} from "./lib/workspaces";
import { useSettings } from "./lib/settings";
import { hideToTray, onCloseRequested, quitApp } from "./lib/window";

/** 新建 / 编辑工作区对话框的状态 */
type DialogState = { mode: "create" } | { mode: "edit"; workspace: Workspace };

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
  /** 全屏区域。会连带隐藏侧边栏，属于窗口级布局，所以不放工作区实例里 */
  const [fullscreen, setFullscreen] = useState<Fullscreen>("none");
  /** 新建 / 编辑工作区的对话框 */
  const [dialog, setDialog] = useState<DialogState | null>(null);
  /** 等着确认移除的工作区；非空时弹确认框 */
  const [pendingRemove, setPendingRemove] = useState<Workspace | null>(null);

  /** 关工作区时要把它那份会话状态一起丢掉，下次打开是干净的 */
  const dropAgentSession = useDropAgentSession();
  /** 给还没切过去的工作区「新建对话」用 */
  const newChatAt = useNewChatAt();

  const { settings, update } = useSettings();
  /** 关窗口的确认框：开着工作区、又还没记住选择时才弹 */
  const [closePrompt, setClosePrompt] = useState(false);

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
   * 侧栏工作区行的 AI CLI 入口：新开一个终端标签启动它，不注入当前终端。
   * `title`（CLI 名）作新标签的标题，让人一眼分辨是哪家 CLI
   */
  const runAiCommand = useCallback((command: string, title: string) => {
    if (!activeIdRef.current) return;
    handlesRef.current.get(activeIdRef.current)?.terminal?.runInNewSession(command, title);
  }, []);

  /**
   * 侧边栏点了某条 CLI 历史会话：新开一个终端标签跑 resume，不动正在用的那个。
   * `title`（被恢复会话的标题）作新标签的标题
   */
  const resumeSession = useCallback((command: string, title: string) => {
    if (!activeIdRef.current) return;
    handlesRef.current.get(activeIdRef.current)?.terminal?.runInNewSession(command, title);
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
      setNotice(`这个目录打不开了：${reason}`);
      return null;
    }
  }, []);

  /**
   * 侧栏工作区行的「+」：新建一条对话。工作区还没打开、或不是当前工作区时，先打开并切过去，
   * 再把它切成 GUI、挂上新建请求——「添加对话」这一步顺带把工作区带成打开状态。
   */
  const newChat = useCallback(
    async (workspace: Workspace) => {
      let root = workspace.activeRoot;
      if (activeIdRef.current !== workspace.id) {
        const next = await openWorkspace(workspace);
        // 目录打不开时 openWorkspace 已经提示过，这里不再建请求
        if (!next) return;
        root = next.activeRoot;
      }
      newChatAt(root);
    },
    [openWorkspace, newChatAt],
  );

  /** 「新建工作区」提交：新建一个工作区并打开它 */
  const createWorkspace = useCallback(
    async (value: { name: string; roots: string[] }) => {
      setDialog(null);
      await openWorkspace({
        id: newWorkspaceId(),
        name: value.name,
        roots: value.roots,
        activeRoot: value.roots[0],
      });
    },
    [openWorkspace],
  );

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
      for (const root of workspace.roots) dropAgentSession(root);
      handlesRef.current.delete(workspace.id);

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
    [dropAgentSession],
  );

  /**
   * 从列表里移除一个工作区。只动 CodeDock 自己的记录，不碰磁盘上的目录。
   * 它还开着的话一并关掉——不然终端和 opencode 会一直在后台跑，用户却再也看不到。
   */
  const removeWorkspace = useCallback(
    (workspace: Workspace) => {
      if (openedRef.current.includes(workspace.id)) closeWorkspace(workspace);
      setWorkspaces(dropWorkspace(workspace.id));
    },
    [closeWorkspace],
  );

  /** 置顶 / 取消置顶。只改记录里的标记，「置顶的排最前」由侧边栏渲染时排序实现 */
  const togglePin = useCallback((workspace: Workspace) => {
    setWorkspaces(saveWorkspace({ ...workspace, pinned: !workspace.pinned }));
  }, []);

  /** 拖拽重排：侧栏算好新顺序（含被拖动项的置顶标记）后整份落盘 */
  const reorder = useCallback((ordered: Workspace[]) => {
    setWorkspaces(reorderWorkspaces(ordered));
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

  // 启动时恢复上次用的工作区。只恢复**一个**：同时挂起多个工作区意味着一次起好几个
  // shell 和 opencode，用户没点过的不该有这种代价
  useEffect(() => {
    let cancelled = false;
    // 旧版「一个目录一个工作区」的记录在这里就地升级成工作区实体
    const list = migrateWorkspaces();
    setWorkspaces(list);

    const lastId = readLastWorkspaceId();
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
    const name = import.meta.env.DEV ? "CodeDock (dev)" : "CodeDock";
    document.title = activeName ? `${name} — ${activeName}` : name;
  }, [activeName]);

  // 别的窗口（如果还开着）改了工作区列表，本窗口的侧栏跟着更新
  useEffect(() => onWorkspacesChanged(setWorkspaces), []);

  /**
   * 打开着的文件被外部改了（终端、git、别的编辑器、智能体写的）就重读回最新的。
   *
   * 只订阅一次、按路径分发：每个路径只喂给**它所属工作区**的编辑器，不然切走的工作区
   * 也会跟着重读一遍。一个工作区可能挂着多个工作目录，落在任意一个根下都算它。
   * 有未保存改动的不覆盖，见 `EditorPane.reload`。
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
        if (mine.length > 0) void handles.editor?.reload(mine);
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

  // Esc 退出全屏。拿不到焦点在 iframe 里敲的 Esc（跨域事件不会冒出来），那种情况只能用按钮
  useEffect(() => {
    if (fullscreen === "none") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFullscreen("none");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [fullscreen]);

  if (booting) {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-fg-faint">
        正在恢复上次的工作区…
      </div>
    );
  }

  return (
    <div className="flex h-full w-full overflow-hidden bg-app">
      {/* 全屏时侧边栏整块藏起来。用 contents 只是让这层壳不参与布局，Sidebar 本身不卸载 */}
      <div className={fullscreen !== "none" ? "hidden" : "contents"}>
        <Sidebar
          workspaces={workspaces}
          currentId={activeId}
          activeRoot={activeRoot}
          opened={opened}
          onSelect={(workspace) => void openWorkspace(workspace)}
          onNewChat={(workspace) => void newChat(workspace)}
          onCreate={() => setDialog({ mode: "create" })}
          onEdit={(workspace) => setDialog({ mode: "edit", workspace })}
          onRemove={setPendingRemove}
          onClose={closeWorkspace}
          onTogglePin={togglePin}
          onReorder={reorder}
          onRunAiCommand={runAiCommand}
          onResumeSession={resumeSession}
        />
      </div>
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
          />
        );
      })}
      {opened.length === 0 && (
        <WorkspaceEmpty
          error={notice}
          onPick={() => {
            setDialog({ mode: "create" });
          }}
        />
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
          message={`从列表里移除工作区「${pendingRemove.name}」？只去掉 CodeDock 里的记录，不会动磁盘上的文件夹。`}
          confirmLabel="移除"
          onConfirm={() => {
            removeWorkspace(pendingRemove);
            setPendingRemove(null);
          }}
          onCancel={() => setPendingRemove(null)}
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
        />
      )}
    </div>
  );
}

export default function App() {
  return (
    <AgentSessionProvider>
      <RemoteHostsProvider>
        <DbConnectionsProvider>
          <Shell />
        </DbConnectionsProvider>
      </RemoteHostsProvider>
    </AgentSessionProvider>
  );
}
