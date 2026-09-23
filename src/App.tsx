import { useCallback, useEffect, useState } from "react";
import { SplitPane } from "./components/SplitPane";
import { Sidebar } from "./components/Sidebar";
import { TerminalPane } from "./components/TerminalPane";
import { ToolPane, readTool, saveTool, type ToolId } from "./components/ToolPane";
import { ToolRail } from "./components/ToolRail";
import { EditorPane } from "./components/EditorPane";
import { BrowserPane } from "./components/BrowserPane";
import { WorkspaceEmpty } from "./components/WorkspaceEmpty";
import { useGitStatus } from "./lib/git";
import { sameTab, type Tab } from "./lib/tabs";
import {
  clearSavedWorkspace,
  pickWorkspaceFolder,
  readSavedWorkspace,
  readSavedWorkspaces,
  samePath,
  saveWorkspace,
  saveWorkspaces,
  setRoot,
} from "./lib/fs";

/**
 * 把 next 提到历史最前并去重。
 * Windows 上大小写、分隔符不同也算同一个目录，只比字符串会把同一个目录存成两条。
 */
function promoteWorkspace(list: string[], next: string): string[] {
  return [next, ...list].filter(
    (item, index, all) => all.findIndex((other) => samePath(other, item)) === index,
  );
}

export default function App() {
  const [root, setRootState] = useState<string | null>(null);
  /** 用过的目录，最近打开的排在最前 */
  const [workspaces, setWorkspaces] = useState<string[]>([]);
  // 编辑器标签按打开顺序排，activeTab 是当前显示的那个。
  // 标签身份是结构化的（文件 / 差异视图），不能只拿路径当键，见 lib/tabs.ts
  const [openTabs, setOpenTabs] = useState<Tab[]>([]);
  const [activeTab, setActiveTab] = useState<Tab | null>(null);
  const [booting, setBooting] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  /** 右栏看的是哪个模块 */
  const [tool, setTool] = useState<ToolId>(readTool);
  /** 右边栏默认收起：打开时只看到侧边栏 + 终端，点终端右上角那个按钮才展开 */
  const [rightOpen, setRightOpen] = useState(false);
  /** 全屏展示：整个右边栏铺满窗口，侧边栏和终端让位 */
  const [fullscreen, setFullscreen] = useState(false);

  // 当前工作区的 git 状态，只读轮询；不是仓库或没选目录时全是空标记
  const git = useGitStatus(root);

  const gitReady = git.snapshot.isRepo;
  // 不是仓库时只能看「文件」。派生值兜底而不是改 state：用户选的「变更」不会被抹掉。
  // 浏览器要本地服务地址，和 git 无关，不参与这个兜底
  const activeTool: ToolId = !gitReady && tool === "changes" ? "files" : tool;
  // 还没选工作区时右边栏里是「选择文件夹」提示，收起来用户就没法选目录了
  const rightShown = rightOpen || root === null;

  const pickTool = useCallback((id: ToolId) => {
    setTool(id);
    saveTool(id);
  }, []);

  const toggleFullscreen = useCallback(() => setFullscreen((on) => !on), []);

  /**
   * 收起右边栏时全屏必须一起退出：那个全屏按钮在面板里，面板收起来就点不到了。
   * 展开时重置也无所谓——能点到这个按钮就说明面板是开着的。
   */
  const toggleRight = useCallback(() => {
    setRightOpen((open) => !open);
    setFullscreen(false);
  }, []);

  // Esc 退出全屏。拿不到焦点在 iframe 里敲的 Esc（跨域事件不会冒出来），那种情况只能用按钮
  useEffect(() => {
    if (!fullscreen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFullscreen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [fullscreen]);

  // 启动时恢复上次的工作区；没记录就停在空态，让用户自己选
  useEffect(() => {
    const saved = readSavedWorkspace();
    const savedList = readSavedWorkspaces();
    setWorkspaces(savedList);

    if (!saved) {
      setBooting(false);
      return;
    }

    let cancelled = false;
    setRoot(saved)
      .then((resolved) => {
        if (cancelled) return;
        saveWorkspace(resolved);
        // 上次用的目录补进历史最前面（顺带清掉历史里同一个目录的其它写法）
        const list = promoteWorkspace(savedList, resolved);
        saveWorkspaces(list);
        setWorkspaces(list);
        setRootState(resolved);
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

  // 切工作区必须两头都换：后端 root 决定文件读写的沙箱边界，前端 root 决定界面
  const applyWorkspace = useCallback(
    async (next: string) => {
      try {
        const resolved = await setRoot(next);
        saveWorkspace(resolved);
        const list = promoteWorkspace(workspaces, resolved);
        saveWorkspaces(list);
        setWorkspaces(list);
        setNotice(null);
        // 旧工作区打开的标签全部作废
        setOpenTabs([]);
        setActiveTab(null);
        setRootState(resolved);
      } catch (reason) {
        setNotice(`这个目录打不开了：${reason}`);
      }
    },
    [workspaces],
  );

  /**
   * 从列表里移除一个项目。只动 CodeDock 自己的记录，不碰磁盘上的目录。
   * 移掉的正好是当前打开的项目时，顺手清掉启动记录，否则下次启动又会被补回列表；
   * 本次会话不动它——关掉工作区会连带杀掉终端、关掉已打开的文件，代价太大。
   */
  const removeWorkspace = useCallback(
    (path: string) => {
      const list = workspaces.filter((item) => !samePath(item, path));
      setWorkspaces(list);
      saveWorkspaces(list);
      if (root && samePath(root, path)) clearSavedWorkspace();
    },
    [workspaces, root],
  );

  /** 已经开着的标签只切过去，不重复开——连点同一个改动项就是这个路径 */
  const openTab = useCallback((tab: Tab) => {
    setOpenTabs((current) => (current.some((item) => sameTab(item, tab)) ? current : [...current, tab]));
    setActiveTab(tab);
  }, []);

  const openFile = useCallback((path: string) => {
    openTab({ kind: "file", path });
  }, [openTab]);

  /** 从「变更」列表面板点进来的：开的是差异视图，不是文件内容 */
  const openDiff = useCallback(
    (path: string, staged: boolean) => {
      openTab({ kind: "diff", path, staged });
    },
    [openTab],
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

  const pickWorkspace = useCallback(async () => {
    try {
      const picked = await pickWorkspaceFolder();
      if (picked) await applyWorkspace(picked);
    } catch (reason) {
      setNotice(String(reason));
    }
  }, [applyWorkspace]);

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
      <div className={fullscreen ? "hidden" : "contents"}>
        <Sidebar
          workspaces={workspaces}
          current={root}
          git={git.snapshot}
          onSelect={applyWorkspace}
          onAdd={pickWorkspace}
          onRemove={removeWorkspace}
        />
      </div>
      <SplitPane
        initial={52}
        min={20}
        max={78}
        secondCollapsed={!rightShown}
        firstCollapsed={fullscreen}
        first={
          // 换工作区时整个终端区重建：每个会话的 shell 都落在旧目录里，留着反而是误导
          <TerminalPane
            key={root ?? ""}
            cwd={root}
            rightOpen={rightShown}
            onToggleRight={root === null ? undefined : toggleRight}
          />
        }
        second={
          root ? (
            <div className="flex min-h-0 min-w-0 flex-1">
              <ToolRail active={activeTool} gitReady={gitReady} onPick={pickTool} />
              {/* 浏览器选中时独占编辑器那一列。编辑区只是隐藏、不卸载，
                  Monaco 的撤销历史和文件树的展开态都留得住。
                  全屏时整块右边栏一起铺满窗口，编辑器那一列照常留着 */}
              <div
                className={
                  activeTool === "browser" ? "hidden" : "flex min-h-0 min-w-0 flex-1"
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
                      selected={activeTab?.kind === "file" ? activeTab.path : null}
                      git={git}
                      onSelectFile={openFile}
                      onOpenDiff={openDiff}
                      fullscreen={fullscreen}
                      onToggleFullscreen={toggleFullscreen}
                    />
                  }
                  second={
                    <EditorPane
                      tabs={openTabs}
                      active={activeTab}
                      gitMarks={git.snapshot.marks}
                      onActivate={setActiveTab}
                      onClose={closeTab}
                    />
                  }
                />
              </div>
              <div
                className={
                  activeTool === "browser" ? "flex min-h-0 min-w-0 flex-1" : "hidden"
                }
              >
                <BrowserPane
                  fullscreen={fullscreen}
                  onToggleFullscreen={toggleFullscreen}
                />
              </div>
            </div>
          ) : (
            <WorkspaceEmpty error={notice} onPick={pickWorkspace} />
          )
        }
      />
    </div>
  );
}
