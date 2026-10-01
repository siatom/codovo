import { useCallback, useEffect, useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { ProjectDialog } from "./components/ProjectDialog";
import { Sidebar } from "./components/Sidebar";
import {
  ProjectWorkspace,
  type Fullscreen,
  type WorkspaceHandles,
} from "./components/ProjectWorkspace";
import { WorkspaceEmpty } from "./components/WorkspaceEmpty";
import { AgentSessionProvider, useDropAgentSession } from "./lib/agent-session";
import {
  isPathInside,
  onFilesChanged,
  projectActivate,
  projectClose,
  projectRegister,
  samePath,
} from "./lib/fs";
import {
  clearLastProjectId,
  dropProject,
  migrateProjects,
  newProjectId,
  onProjectsChanged,
  readLastProjectId,
  saveLastProjectId,
  saveProject,
  type Project,
} from "./lib/projects";
import { useSettings } from "./lib/settings";
import { hideToTray, onCloseRequested, quitApp } from "./lib/window";

/** 新建 / 编辑项目对话框的状态 */
type DialogState = { mode: "create" } | { mode: "edit"; project: Project };

/**
 * 一个窗口，多个项目并行。
 *
 * 每个打开的项目各挂一个 `ProjectWorkspace` 实例，非当前的藏着不卸载——切项目就是
 * 切 `visible`，于是终端会话、智能体对话、编辑器标签、文件树展开态全都原样保留，
 * 后台的进程也照跑。这正是和传统 IDE「一个窗口一个项目」最大的不同。
 *
 * 项目是**一对多**的：一个项目可以挂多个源文件夹（`project.roots`），文件树把它们
 * 并列显示；终端 / 变更 / 智能体这些一次只认一个根，跟 `project.activeRoot` 走。
 *
 * 侧栏那份 `projects` 是「用过的项目」，`opened` 是其中已经打开的那些。
 */
function Shell() {
  /** 全部项目，最近创建/打开的排在最前 */
  const [projects, setProjects] = useState<Project[]>([]);
  /** 已经打开的项目 id（各自有工作区实例），按打开顺序 */
  const [opened, setOpened] = useState<string[]>([]);
  /** 当前显示哪个项目 */
  const [activeId, setActiveId] = useState<string | null>(null);
  const [booting, setBooting] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  /** 全屏区域。会连带隐藏侧边栏，属于窗口级布局，所以不放项目实例里 */
  const [fullscreen, setFullscreen] = useState<Fullscreen>("none");
  /** 新建 / 编辑项目的对话框 */
  const [dialog, setDialog] = useState<DialogState | null>(null);
  /** 等着确认移除的项目；非空时弹确认框 */
  const [pendingRemove, setPendingRemove] = useState<Project | null>(null);

  /** 关项目时要把它那份会话状态一起丢掉，下次打开是干净的 */
  const dropAgentSession = useDropAgentSession();

  const { settings, update } = useSettings();
  /** 关窗口的确认框：开着项目、又还没记住选择时才弹 */
  const [closePrompt, setClosePrompt] = useState(false);

  const activeProject = projects.find((item) => item.id === activeId) ?? null;
  const activeRoot = activeProject?.activeRoot ?? null;

  /**
   * 几个 handle 与项目状态的最新快照。切项目、关项目、磁盘事件回调都要读「此刻」
   * 的值，而不是注册那一刻闭包里的——放 ref 里最省事，也免得 effect 反复重注册。
   */
  const projectsRef = useRef<Project[]>([]);
  projectsRef.current = projects;
  const openedRef = useRef<string[]>([]);
  openedRef.current = opened;
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;

  /**
   * 关窗口那一下已经被后端拦下了（`prevent_close`），是收进托盘还是真退出由这儿说了算。
   * 项目列表和设置都变得勤，用 ref 兜住最新值、监听只注册一次——每次变化都重注册
   * 会跟卸载抢时间，回调可能打到已经被清的监听上。
   */
  const onCloseRef = useRef<() => void>(() => {});
  onCloseRef.current = () => {
    if (opened.length === 0) {
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
   * 项目 id -> 该项目的两个 handle。侧栏的 AI CLI 命令、编辑器浮窗得打到**当前项目**
   * 的实例上，而 handle 是各实例自己的
   */
  const handlesRef = useRef(new Map<string, WorkspaceHandles>());
  const onHandles = useCallback((projectId: string, handles: WorkspaceHandles) => {
    handlesRef.current.set(projectId, handles);
  }, []);

  /** 侧栏项目行的 AI CLI 入口：新开一个终端标签启动它，不注入当前终端 */
  const runAiCommand = useCallback((command: string) => {
    if (!activeIdRef.current) return;
    handlesRef.current.get(activeIdRef.current)?.terminal?.runInNewSession(command);
  }, []);

  /** 侧边栏点了某条 CLI 历史会话：新开一个终端标签跑 resume，不动正在用的那个 */
  const resumeSession = useCallback((command: string) => {
    if (!activeIdRef.current) return;
    handlesRef.current.get(activeIdRef.current)?.terminal?.runInNewSession(command);
  }, []);

  /**
   * 打开 / 切换项目。已经打开过的就只切过去，不重建实例。
   *
   * 每次都要 activate：后端的目录监听是一组根的**整体替换**，只跟当前项目——
   * 切过去时不重新登记，新项目的根就没人盯着。
   */
  const openProject = useCallback(async (project: Project) => {
    try {
      const resolved = await projectActivate(project.roots);
      // 活动根要落到 canonical 后的路径上，否则后端按它查白名单会落空
      const index = project.roots.findIndex((root) => samePath(root, project.activeRoot));
      const next: Project = {
        ...project,
        roots: resolved,
        activeRoot: resolved[index >= 0 ? index : 0] ?? project.activeRoot,
      };
      setProjects(saveProject(next));
      setOpened((current) => (current.includes(next.id) ? current : [...current, next.id]));
      setActiveId(next.id);
      saveLastProjectId(next.id);
      setNotice(null);
    } catch (reason) {
      setNotice(`这个目录打不开了：${reason}`);
    }
  }, []);

  /** 「创建项目」提交：新建一个项目并打开它 */
  const createProject = useCallback(
    async (value: { name: string; roots: string[] }) => {
      setDialog(null);
      await openProject({
        id: newProjectId(),
        name: value.name,
        roots: value.roots,
        activeRoot: value.roots[0],
      });
    },
    [openProject],
  );

  /**
   * 「编辑项目」提交：改名字与源文件夹。
   *
   * 开着的项目要顺手把新根登记进后端，否则文件树读不到；但**只有当前项目**才整体
   * 换目录监听，后台项目只登记（`project_register`），免得监听被抢走。
   */
  const applyEdit = useCallback(
    async (project: Project, value: { name: string; roots: string[] }) => {
      setDialog(null);
      const index = value.roots.findIndex((root) => samePath(root, project.activeRoot));
      const next: Project = {
        ...project,
        name: value.name,
        roots: value.roots,
        activeRoot: value.roots[index >= 0 ? index : 0] ?? project.activeRoot,
      };

      if (openedRef.current.includes(project.id)) {
        try {
          const resolved =
            activeIdRef.current === project.id
              ? await projectActivate(next.roots)
              : await projectRegister(next.roots);
          next.roots = resolved;
          next.activeRoot = resolved[index >= 0 ? index : 0] ?? next.activeRoot;
        } catch (reason) {
          setNotice(`项目改不动了：${reason}`);
        }
      }
      setProjects(saveProject(next));
    },
    [],
  );

  /** 关闭一个已打开的项目：收它的终端与 opencode 进程、丢掉它的界面实例 */
  const closeProject = useCallback(
    (project: Project) => {
      void projectClose(project.roots).catch(() => {});
      // 每个根在会话状态里各占一份，都要丢
      for (const root of project.roots) dropAgentSession(root);
      handlesRef.current.delete(project.id);

      const rest = openedRef.current.filter((id) => id !== project.id);
      setOpened(rest);
      if (activeIdRef.current !== project.id) return;

      // 关的就是当前这个：切到还开着的第一个，没有就回到空态
      const nextId = rest[0] ?? null;
      setActiveId(nextId);
      setFullscreen("none");
      if (nextId) {
        saveLastProjectId(nextId);
        const nextProject = projectsRef.current.find((item) => item.id === nextId);
        // 当前项目换人了，后端的目录监听也得跟着挪
        if (nextProject) void projectActivate(nextProject.roots).catch(() => {});
      } else {
        clearLastProjectId();
      }
    },
    [dropAgentSession],
  );

  /**
   * 从列表里移除一个项目。只动 CodeDock 自己的记录，不碰磁盘上的目录。
   * 它还开着的话一并关掉——不然终端和 opencode 会一直在后台跑，用户却再也看不到。
   */
  const removeProject = useCallback(
    (project: Project) => {
      if (openedRef.current.includes(project.id)) closeProject(project);
      setProjects(dropProject(project.id));
    },
    [closeProject],
  );

  /** 置顶 / 取消置顶。只改记录里的标记，「置顶的排最前」由侧边栏渲染时排序实现 */
  const togglePin = useCallback((project: Project) => {
    setProjects(saveProject({ ...project, pinned: !project.pinned }));
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

  // 启动时恢复上次用的项目。只恢复**一个**：同时挂起多个工作区意味着一次起好几个
  // shell 和 opencode，用户没点过的不该有这种代价
  useEffect(() => {
    let cancelled = false;
    // 旧版「一个目录一个项目」的记录在这里就地升级成项目实体
    const list = migrateProjects();
    setProjects(list);

    const lastId = readLastProjectId();
    const last = list.find((item) => item.id === lastId) ?? null;
    if (!last) {
      setBooting(false);
      return;
    }
    void projectActivate(last.roots)
      .then((resolved) => {
        if (cancelled) return;
        const index = last.roots.findIndex((root) => samePath(root, last.activeRoot));
        const next: Project = {
          ...last,
          roots: resolved,
          activeRoot: resolved[index >= 0 ? index : 0] ?? last.activeRoot,
        };
        setProjects(saveProject(next));
        setOpened([next.id]);
        setActiveId(next.id);
      })
      .catch((reason) => {
        if (cancelled) return;
        // 目录被删了/换盘了，清掉记录回到空态，别让用户每次启动都撞同一个错
        clearLastProjectId();
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
  const activeName = activeProject?.name ?? null;
  useEffect(() => {
    const name = import.meta.env.DEV ? "CodeDock (dev)" : "CodeDock";
    document.title = activeName ? `${name} — ${activeName}` : name;
  }, [activeName]);

  // 别的窗口（如果还开着）改了项目列表，本窗口的侧栏跟着更新
  useEffect(() => onProjectsChanged(setProjects), []);

  /**
   * 打开着的文件被外部改了（终端、git、别的编辑器、智能体写的）就重读回最新的。
   *
   * 只订阅一次、按路径分发：每个路径只喂给**它所属项目**的编辑器，不然切走的项目
   * 也会跟着重读一遍。一个项目可能挂着多个源文件夹，落在任意一个根下都算它。
   * 有未保存改动的不覆盖，见 `EditorPane.reload`。
   */
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    void onFilesChanged((paths) => {
      for (const [id, handles] of handlesRef.current) {
        const project = projectsRef.current.find((item) => item.id === id);
        if (!project) continue;
        const mine = paths.filter((path) =>
          project.roots.some((root) => isPathInside(path, root)),
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
        正在恢复上次的工作目录…
      </div>
    );
  }

  return (
    <div className="flex h-full w-full overflow-hidden bg-app">
      {/* 全屏时侧边栏整块藏起来。用 contents 只是让这层壳不参与布局，Sidebar 本身不卸载 */}
      <div className={fullscreen !== "none" ? "hidden" : "contents"}>
        <Sidebar
          projects={projects}
          currentId={activeId}
          activeRoot={activeRoot}
          opened={opened}
          onSelect={(project) => void openProject(project)}
          onCreate={() => setDialog({ mode: "create" })}
          onEdit={(project) => setDialog({ mode: "edit", project })}
          onRemove={setPendingRemove}
          onClose={closeProject}
          onTogglePin={togglePin}
          onRunAiCommand={runAiCommand}
          onResumeSession={resumeSession}
        />
      </div>
      {/* 每个打开的项目一个工作区实例：非当前的 hidden 藏着不卸载，切回来是原样 */}
      {opened.map((id) => {
        const project = projects.find((item) => item.id === id);
        if (!project) return null;
        return (
          <ProjectWorkspace
            key={id}
            project={project}
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
        <ProjectDialog
          mode={dialog.mode}
          initialName={dialog.mode === "edit" ? dialog.project.name : undefined}
          initialRoots={dialog.mode === "edit" ? dialog.project.roots : undefined}
          onCancel={() => setDialog(null)}
          onSubmit={(value) => {
            if (dialog.mode === "create") void createProject(value);
            else void applyEdit(dialog.project, value);
          }}
          onRemove={
            dialog.mode === "edit"
              ? () => {
                  const target = dialog.project;
                  setDialog(null);
                  setPendingRemove(target);
                }
              : undefined
          }
        />
      )}

      {/* 移除项目不可撤销（项目配置会一起没），走自研确认框 */}
      {pendingRemove && (
        <ConfirmDialog
          message={`从列表里移除项目「${pendingRemove.name}」？只去掉 CodeDock 里的记录，不会动磁盘上的文件夹。`}
          confirmLabel="移除"
          onConfirm={() => {
            removeProject(pendingRemove);
            setPendingRemove(null);
          }}
          onCancel={() => setPendingRemove(null)}
        />
      )}

      {closePrompt && (
        <ConfirmDialog
          message={`还有 ${opened.length} 个项目开着，终端与智能体仍在后台运行。`}
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
