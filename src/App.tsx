import { useCallback, useEffect, useState } from "react";
import { SplitPane } from "./components/SplitPane";
import { Sidebar } from "./components/Sidebar";
import { TerminalPane } from "./components/TerminalPane";
import { ExplorerPane } from "./components/ExplorerPane";
import { EditorPane } from "./components/EditorPane";
import { WorkspaceEmpty } from "./components/WorkspaceEmpty";
import { useGitStatus } from "./lib/git";
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
  // 编辑器打开的文件按打开顺序排成标签，activePath 是当前显示的那个
  const [openPaths, setOpenPaths] = useState<string[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [booting, setBooting] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);

  // 当前工作区的 git 状态，只读轮询；不是仓库或没选目录时全是空标记
  const git = useGitStatus(root);

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
        // 旧工作区打开的文件全部作废
        setOpenPaths([]);
        setActivePath(null);
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

  const openFile = useCallback((path: string) => {
    setOpenPaths((current) => (current.includes(path) ? current : [...current, path]));
    setActivePath(path);
  }, []);

  const closeFile = useCallback(
    (path: string) => {
      const index = openPaths.indexOf(path);
      if (index === -1) return;
      const rest = openPaths.filter((item) => item !== path);
      setOpenPaths(rest);
      // 关掉的是当前文件时，焦点落到它右边那个（没有就往左退一格）
      if (activePath === path) {
        setActivePath(rest[Math.min(index, rest.length - 1)] ?? null);
      }
    },
    [openPaths, activePath],
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
      <Sidebar
        workspaces={workspaces}
        current={root}
        git={git}
        onSelect={applyWorkspace}
        onAdd={pickWorkspace}
        onRemove={removeWorkspace}
      />
      <SplitPane
        initial={52}
        min={20}
        max={78}
        first={
          // 换工作区时整个终端区重建：每个会话的 shell 都落在旧目录里，留着反而是误导
          <TerminalPane key={root ?? ""} cwd={root} />
        }
        second={
          root ? (
            <SplitPane
              initial={28}
              min={12}
              max={45}
              first={
                <ExplorerPane
                  root={root}
                  selected={activePath}
                  gitMarks={git.marks}
                  onSelect={openFile}
                />
              }
              second={
                <EditorPane
                  paths={openPaths}
                  active={activePath}
                  gitMarks={git.marks}
                  onActivate={setActivePath}
                  onClose={closeFile}
                />
              }
            />
          ) : (
            <WorkspaceEmpty error={notice} onPick={pickWorkspace} />
          )
        }
      />
    </div>
  );
}
