import { useCallback, useEffect, useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { Sidebar } from "./components/Sidebar";
import {
  ProjectWorkspace,
  type Fullscreen,
  type WorkspaceHandles,
} from "./components/ProjectWorkspace";
import { WorkspaceEmpty } from "./components/WorkspaceEmpty";
import { AgentSessionProvider, useDropAgentSession } from "./lib/agent-session";
import { isPathInside } from "./lib/fs";
import {
  addSavedWorkspace,
  clearSavedWorkspace,
  dropSavedWorkspace,
  onFilesChanged,
  onWorkspacesChanged,
  pickFolder,
  projectActivate,
  projectClose,
  readSavedWorkspace,
  readSavedWorkspaces,
  samePath,
  saveWorkspace,
} from "./lib/fs";
import { useSettings } from "./lib/settings";
import { hideToTray, onCloseRequested, quitApp } from "./lib/window";

/** 取路径最后一段当显示名；盘符根这类取不到就退回原串 */
function baseName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}

/**
 * 一个窗口，多个项目并行。
 *
 * 每个打开的项目各挂一个 `ProjectWorkspace` 实例，非当前的藏着不卸载——切项目就是
 * 切 `visible`，于是终端会话、智能体对话、编辑器标签、文件树展开态全都原样保留，
 * 后台的进程也照跑。这正是和传统 IDE「一个窗口一个项目」最大的不同。
 *
 * 项目列表（`projects`）是「已经打开的」，侧栏那份（`workspaces`）是「用过的目录」；
 * 点侧栏没打开过的 = 打开并切过去，点已打开的 = 直接切过去。
 */
function Shell() {
  /** 已经打开的项目（各自有工作区实例），按打开顺序 */
  const [projects, setProjects] = useState<string[]>([]);
  /** 当前显示哪个项目 */
  const [activeRoot, setActiveRoot] = useState<string | null>(null);
  /** 用过的目录，最近打开的排在最前 */
  const [workspaces, setWorkspaces] = useState<string[]>([]);
  const [booting, setBooting] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  /** 全屏区域。会连带隐藏侧边栏，属于窗口级布局，所以不放项目实例里 */
  const [fullscreen, setFullscreen] = useState<Fullscreen>("none");

  /** 关项目时要把它那份会话状态一起丢掉，下次打开是干净的 */
  const dropAgentSession = useDropAgentSession();

  const { settings, update } = useSettings();
  /** 关窗口的确认框：开着项目、又还没记住选择时才弹 */
  const [closePrompt, setClosePrompt] = useState(false);

  /**
   * 关窗口那一下已经被后端拦下了（`prevent_close`），是收进托盘还是真退出由这儿说了算。
   * 项目列表和设置都变得勤，用 ref 兜住最新值、监听只注册一次——每次变化都重注册
   * 会跟卸载抢时间，回调可能打到已经被清的监听上。
   */
  const onCloseRef = useRef<() => void>(() => {});
  onCloseRef.current = () => {
    if (projects.length === 0) {
      // 没项目就别留个空壳进程在后台
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
   * root -> 该项目的两个 handle。侧栏的 AI CLI 命令、编辑器浮窗得打到**当前项目**
   * 的实例上，而 handle 是各实例自己的
   */
  const handlesRef = useRef(new Map<string, WorkspaceHandles>());
  const onHandles = useCallback((root: string, handles: WorkspaceHandles) => {
    handlesRef.current.set(root, handles);
  }, []);

  /** 侧栏项目行的 AI CLI 入口：新开一个终端标签启动它，不注入当前终端 */
  const runAiCommand = useCallback(
    (command: string) => {
      if (!activeRoot) return;
      handlesRef.current.get(activeRoot)?.terminal?.runInNewSession(command);
    },
    [activeRoot],
  );

  /** 侧边栏点了某条 CLI 历史会话：新开一个终端标签跑 resume，不动正在用的那个 */
  const resumeSession = useCallback(
    (command: string) => {
      if (!activeRoot) return;
      handlesRef.current.get(activeRoot)?.terminal?.runInNewSession(command);
    },
    [activeRoot],
  );

  /** 打开 / 切换项目。已经打开过的就只切过去，不重建实例 */
  const openProject = useCallback(async (path: string) => {
    try {
      const resolved = await projectActivate(path);
      saveWorkspace(resolved);
      setWorkspaces(addSavedWorkspace(resolved));
      setProjects((current) =>
        current.some((item) => samePath(item, resolved)) ? current : [...current, resolved],
      );
      setActiveRoot(resolved);
      setNotice(null);
    } catch (reason) {
      setNotice(`这个目录打不开了：${reason}`);
    }
  }, []);

  /** 关闭一个已打开的项目：收它的终端与 opencode 进程、丢掉它的界面实例 */
  const closeProject = useCallback(
    (target: string) => {
      void projectClose(target).catch(() => {});
      dropAgentSession(target);
      handlesRef.current.delete(target);

      const rest = projects.filter((item) => !samePath(item, target));
      setProjects(rest);
      if (!activeRoot || !samePath(activeRoot, target)) return;

      // 关的就是当前这个：切到还开着的第一个，没有就回到空态
      const next = rest[0] ?? null;
      setActiveRoot(next);
      setFullscreen("none");
      if (next) {
        saveWorkspace(next);
        // 当前项目换人了，后端的目录监听也得跟着挪
        void projectActivate(next).catch(() => {});
      } else {
        clearSavedWorkspace();
      }
    },
    [projects, activeRoot, dropAgentSession],
  );

  /**
   * 从列表里移除一个项目。只动 CodeDock 自己的记录，不碰磁盘上的目录。
   * 它还开着的话一并关掉——不然终端和 opencode 会一直在后台跑，用户却再也看不到。
   */
  const removeWorkspace = useCallback(
    (path: string) => {
      if (projects.some((item) => samePath(item, path))) closeProject(path);
      setWorkspaces(dropSavedWorkspace(path));
    },
    [projects, closeProject],
  );

  /** 「打开项目」：弹目录框，选中就打开并切过去 */
  const pickWorkspace = useCallback(async () => {
    try {
      const picked = await pickFolder();
      if (picked) await openProject(picked);
    } catch (reason) {
      setNotice(String(reason));
    }
  }, [openProject]);

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

  // 启动时恢复上次用的项目。只恢复**一个**：同时挂起多个工作区意味着一次起好几个
  // shell 和 opencode，用户没点过的不该有这种代价
  useEffect(() => {
    let cancelled = false;
    setWorkspaces(readSavedWorkspaces());

    const saved = readSavedWorkspace();
    if (!saved) {
      setBooting(false);
      return;
    }
    void projectActivate(saved)
      .then((resolved) => {
        if (cancelled) return;
        saveWorkspace(resolved);
        setWorkspaces(addSavedWorkspace(resolved));
        setProjects([resolved]);
        setActiveRoot(resolved);
      })
      .catch((reason) => {
        if (cancelled) return;
        // 目录被删了/换盘了，清掉记录回到空态，别让用户每次启动都撞同一个错
        clearSavedWorkspace();
        setNotice(`上次的工作目录打不开了：${reason}`);
      })
      .finally(() => {
        if (!cancelled) setBooting(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // 窗口标题跟着当前项目走，用户和调试脚本都靠它分辨现在在哪个项目上。
  // dev 构建额外带个 (dev)：和安装版并存时一眼分得清。标记只放在标题里，
  // 版本号本身保持纯数字——Windows 的 exe 版本资源不接受后缀。
  useEffect(() => {
    const name = import.meta.env.DEV ? "CodeDock (dev)" : "CodeDock";
    document.title = activeRoot ? `${name} — ${baseName(activeRoot)}` : name;
  }, [activeRoot]);

  // 别的窗口（如果还开着）改了项目列表，本窗口的侧栏跟着更新
  useEffect(() => onWorkspacesChanged(setWorkspaces), []);

  /**
   * 打开着的文件被外部改了（终端、git、别的编辑器、智能体写的）就重读回最新的。
   *
   * 只订阅一次、按路径分发：每个路径只喂给**它所属项目**的编辑器，不然切走的项目
   * 也会跟着重读一遍。有未保存改动的不覆盖，见 `EditorPane.reload`。
   */
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    void onFilesChanged((paths) => {
      for (const [root, handles] of handlesRef.current) {
        const mine = paths.filter((path) => isPathInside(path, root));
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
        正在恢复上次的工作目录…
      </div>
    );
  }

  return (
    <div className="flex h-full w-full overflow-hidden bg-app">
      {/* 全屏时侧边栏整块藏起来。用 contents 只是让这层壳不参与布局，Sidebar 本身不卸载 */}
      <div className={fullscreen !== "none" ? "hidden" : "contents"}>
        <Sidebar
          workspaces={workspaces}
          current={activeRoot}
          opened={projects}
          onSelect={openProject}
          onAdd={pickWorkspace}
          onRemove={removeWorkspace}
          onClose={closeProject}
          onRunAiCommand={runAiCommand}
          onResumeSession={resumeSession}
        />
      </div>
      {/* 每个打开的项目一个工作区实例：非当前的 hidden 藏着不卸载，切回来是原样 */}
      {projects.map((root) => (
        <ProjectWorkspace
          key={root}
          root={root}
          visible={root === activeRoot}
          fullscreen={fullscreen}
          onToggleRightFullscreen={toggleRightFullscreen}
          onToggleLeftFullscreen={toggleLeftFullscreen}
          onExitFullscreen={exitFullscreen}
          onHandles={onHandles}
        />
      ))}
      {projects.length === 0 && (
        <WorkspaceEmpty error={notice} onPick={pickWorkspace} />
      )}
      {closePrompt && (
        <ConfirmDialog
          message={`还有 ${projects.length} 个项目开着，终端与智能体仍在后台运行。`}
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
      <Shell />
    </AgentSessionProvider>
  );
}
