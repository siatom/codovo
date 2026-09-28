import { openPath } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import { formatTime } from "../lib/agent";
import { useAgentSession } from "../lib/agent-session";
import { readCliChoice, saveCliChoice } from "../lib/cli-sessions";
import {
  onWorkspaceNamesChanged,
  readWorkspaceNames,
  samePath,
  saveWorkspaceNames,
  toDisplayPath,
} from "../lib/fs";
import { useSettings } from "../lib/settings";
import { useTheme } from "../lib/theme";
import type { AgentSessionSummary } from "../lib/types";
import { CliHistory } from "./CliHistory";
import { ConfirmDialog } from "./ConfirmDialog";
import { SettingsDialog } from "./SettingsDialog";
import {
  AgentLogo,
  IconChevronDown,
  IconChevronRight,
  IconFolder,
  IconFolderPlus,
  IconMoon,
  IconMore,
  IconPanelCollapse,
  IconPanelExpand,
  IconPlus,
  IconSettings,
  IconSun,
} from "./icons";

interface SidebarProps {
  /** 用过的目录，最近打开的排在最前 */
  workspaces: string[];
  /** 当前工作区；null 表示还没选 */
  current: string | null;
  /** 已经打开（挂着工作区实例、后台仍在跑）的项目根，用来在列表里点出「已打开」 */
  opened: string[];
  onSelect: (path: string) => void;
  onAdd: () => void;
  /** 只从列表里去掉，不碰磁盘上的目录 */
  onRemove: (path: string) => void;
  /** 启动 AI CLI：由 App 转成「新开一个终端标签跑这条命令」，不注入当前终端 */
  onRunAiCommand: (command: string) => void;
  /** 点一条 CLI 会话历史：由 App 转成"新开终端标签跑 resume" */
  onResumeSession: (command: string) => void;
}

/** 窗口级偏好，存 sessionStorage：多窗口下各收各的侧边栏 */
const COLLAPSED_KEY = "codedock.sidebarCollapsed";

/** 导航行的固定高度：展开态和收起态共用，来回切换时图标不会上下跳 */
const ROW_H = "h-[34px]";

/** 一行导航/列表项的统一样式，只靠调用处追加选中态 */
const ROW = `flex w-full ${ROW_H} items-center gap-2.5 rounded-lg px-2 text-left text-[13px] text-fg-muted hover:bg-hover hover:text-fg`;

const FOOTER_BUTTON =
  "flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-fg-dim hover:bg-hover hover:text-fg";

/** 行内操作按钮：平时藏起来，悬停或键盘聚焦时才出现并接受点击 */
const ROW_ACTION =
  "pointer-events-none flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-faint opacity-0 hover:text-fg focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100";

/** 项目行「⋯」弹出来的菜单项 */
const MENU_ITEM = "px-3 py-1 text-left text-[12px] text-fg-muted hover:bg-hover hover:text-fg";

/** 菜单宽度（px），贴着按钮右边缘往左排时要拿它算 left */
const MENU_W = 112;

/** AI CLI 菜单比别的菜单宽：名字前面多了个 logo，112 会把 codebuddy 这种名字挤断 */
const AI_MENU_W = 150;

function readCollapsed(): boolean {
  try {
    return window.sessionStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

/** 末级目录名，取不到就退回整个路径 */
function baseName(path: string): string {
  const parts = toDisplayPath(path).split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function Sidebar({
  workspaces,
  current,
  opened,
  onSelect,
  onAdd,
  onRemove,
  onRunAiCommand,
  onResumeSession,
}: SidebarProps) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 当前项目的对话历史是否展开；默认展开 */
  const [historyOpen, setHistoryOpen] = useState(true);
  /** 等待确认删除的会话；非空时弹确认框 */
  const [pendingDelete, setPendingDelete] = useState<AgentSessionSummary | null>(null);
  /** 项目在 CodeDock 里的显示名（别名）；只影响界面，不改磁盘上的文件夹名 */
  const [names, setNames] = useState(readWorkspaceNames);
  /** 「⋯」菜单开在哪个项目上，以及贴着按钮的位置 */
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  /** AI CLI 菜单开在哪儿；配了多个命令时才用得上，位置同项目菜单 */
  const [aiMenu, setAiMenu] = useState<{ x: number; y: number } | null>(null);
  /** 正在就地改名的项目 */
  const [renaming, setRenaming] = useState<{ path: string; value: string } | null>(null);
  /** 会话行的「⋯」菜单开在哪条会话上，位置同项目菜单 */
  const [histMenu, setHistMenu] = useState<{
    item: AgentSessionSummary;
    x: number;
    y: number;
  } | null>(null);
  /** 正在就地改名的会话 */
  const [renamingSession, setRenamingSession] = useState<{
    id: string;
    value: string;
  } | null>(null);
  /** 底部会话历史里当前选的是哪条命令；按项目记住 */
  const [cliChoice, setCliChoice] = useState(() => readCliChoice(current));
  const { theme, toggle } = useTheme();
  const { settings } = useSettings();

  // 别的窗口改了项目别名，本窗口的列表跟着更新
  useEffect(() => onWorkspaceNamesChanged(setNames), []);
  const {
    mode,
    sessions,
    currentId,
    requestSession,
    requestDelete,
    requestNew,
    requestRename,
  } = useAgentSession(current);
  // 对话历史只在终端区停在 GUI 时出现：TUI 下智能体服务多半没起，列出来也没意义
  const guiActive = settings.agentEnabled && mode === "agent";
  // 空命令是用户在设置里加了还没填的，不进菜单
  const aiCommands = settings.aiCommands
    .map((item) => ({ ...item, name: item.name.trim(), command: item.command.trim() }))
    .filter((item) => item.command);

  // 底部会话历史选中的命令。存的那条可能已经从设置里删掉了，回落第一条
  const activeCliCommand =
    aiCommands.find((item) => item.command === cliChoice)?.command ??
    aiCommands[0]?.command ??
    "";

  // 换项目要跟着换回这个项目上次选的 CLI
  useEffect(() => {
    setCliChoice(readCliChoice(current));
  }, [current]);

  /** 选 CLI：改状态并按项目落盘。项目行的 + 和底部选择器共用它 */
  const pickCli = (command: string) => {
    setCliChoice(command);
    saveCliChoice(current, command);
  };

  const setCollapsedPersisted = (next: boolean) => {
    setCollapsed(next);
    try {
      window.sessionStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
    } catch {
      // 记不住就每次启动按展开算，不影响使用
    }
  };

  /** 列表里显示的名字：有别名的用别名，否则用目录名 */
  const displayName = (path: string) => names[path] ?? baseName(path);

  /**
   * 改名只写 CodeDock 的显示名，**不动磁盘上的文件夹**。
   * 清空、或者写回目录原名，都等于不要别名——留一条没意义的记录反而会在
   * 用户真的去改目录名之后继续盖住新名字。
   */
  const renameWorkspace = (path: string, value: string) => {
    const name = value.trim();
    // 先读一遍最新的：别的窗口可能刚改过，拿本窗口的 state 覆盖会丢改动
    const next = readWorkspaceNames();
    if (!name || name === baseName(path)) delete next[path];
    else next[path] = name;
    setNames(next);
    saveWorkspaceNames(next);
    setRenaming(null);
  };

  /** 只去掉 CodeDock 里的记录，连同它的别名，不碰磁盘 */
  const removeWorkspace = (path: string) => {
    setMenu(null);
    onRemove(path);
    const next = readWorkspaceNames();
    delete next[path];
    setNames(next);
    saveWorkspaceNames(next);
  };

  /** 用系统的文件浏览器打开这个目录（Windows 资源管理器 / macOS 访达 / Linux 文件管理器） */
  const openInSystem = (path: string) => {
    setMenu(null);
    void openPath(path).catch(() => {
      // 打不开就算了（目录可能已经被删或改名），列表记录留着不动
    });
  };

  const openMenu = (path: string, target: HTMLElement) => {
    const rect = target.getBoundingClientRect();
    setMenu({ path, x: rect.right, y: rect.bottom });
  };

  const openHistMenu = (item: AgentSessionSummary, target: HTMLElement) => {
    const rect = target.getBoundingClientRect();
    setHistMenu({ item, x: rect.right, y: rect.bottom });
  };

  /** 点项目行右侧的「+」：只有一个命令就直接跑，配了多个才出菜单挑 */
  const launchAi = (target: HTMLElement) => {
    if (aiCommands.length === 1) {
      // 顺便把底部会话历史的选择器切过去，两边始终看同一家
      pickCli(aiCommands[0].command);
      onRunAiCommand(aiCommands[0].command);
      return;
    }
    const rect = target.getBoundingClientRect();
    setAiMenu({ x: rect.right, y: rect.bottom });
  };

  /**
   * 会话改名：空标题当取消（后端也拒），没改动就不打后端。
   * 真正的 PATCH 由 AgentPane 做——它拿着刷新列表的入口，改完侧边栏自然换字。
   */
  const renameSession = (id: string, value: string) => {
    setRenamingSession(null);
    const title = value.trim();
    if (!title) return;
    if (sessions.find((item) => item.id === id)?.title === title) return;
    requestRename(id, title);
  };

  // 收起后留一个图标宽的竖条：常用入口（打开项目、主题）仍然够得着，
  // 顶上那个按钮负责展开。
  // 每段的上下留白都照展开态来（头部同高、导航行同高、底部同边距），
  // 这样来回切换时图标只横向挪位，不会上下跳。
  if (collapsed) {
    return (
      <div className="flex h-full w-11 shrink-0 flex-col border-r border-line bg-panel">
        {/* 顶部空出和展开态头部同高的一段：来回切换时下面的图标只横向挪位、不上下跳 */}
        <div className="h-11 shrink-0" />

        <div className="flex shrink-0 flex-col px-2 pb-1">
          <button
            type="button"
            onClick={onAdd}
            title="打开项目"
            className={`flex w-7 ${ROW_H} items-center justify-center rounded-lg text-fg-dim hover:bg-hover hover:text-fg`}
          >
            <IconFolderPlus />
          </button>
        </div>

        <div className="mt-auto flex flex-col items-center gap-1 py-2">
          <button
            type="button"
            onClick={toggle}
            title={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
            className={FOOTER_BUTTON}
          >
            {theme === "dark" ? <IconSun /> : <IconMoon />}
          </button>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            title="设置"
            className={FOOTER_BUTTON}
          >
            <IconSettings />
          </button>
          <button
            type="button"
            onClick={() => setCollapsedPersisted(false)}
            title="展开侧边栏"
            className={FOOTER_BUTTON}
          >
            <IconPanelExpand />
          </button>
        </div>

        {settingsOpen && (
          <SettingsDialog onClose={() => setSettingsOpen(false)} cwd={current} />
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full w-60 shrink-0 flex-col border-r border-line bg-panel">
      {/* 标题栏只放 CodeDock，顶部高度与右侧保持一致 */}
      <header className="flex h-11 shrink-0 items-center px-2">
        {/* Beta 当上标用：内联元素照常占位，靠相对位移浮到 CodeDock 右上角 */}
        <span className="shrink-0 px-2 text-[16px] font-semibold text-fg">
          CodeDock
          <span className="relative -top-2 ml-1 rounded border border-accent-line px-1 text-[9px] font-medium leading-[13px] text-accent">
            Beta
          </span>
        </span>
      </header>

      <nav className="flex shrink-0 flex-col gap-0.5 px-2 pb-1">
        <button type="button" onClick={onAdd} className={ROW}>
          <IconFolderPlus />
          <span className="truncate">打开项目</span>
        </button>
      </nav>

      <p className="shrink-0 px-4 pt-3 pb-1 text-[11px] font-medium tracking-wide text-fg-faint">
        项目
      </p>
      <ul className="min-h-0 flex-1 overflow-auto px-2 pb-2">
        {workspaces.length === 0 && (
          <li className="px-2 py-1 text-[12px] text-fg-faint">还没有打开过目录</li>
        )}
        {workspaces.map((path) => {
          const isCurrent = path === current;
          // 已打开 = 后台挂着工作区实例的项目，和「只是用过的目录」区分开
          const isOpen = opened.some((item) => samePath(item, path));
          return (
            <li key={path}>
              {/* 选中底色罩住整项（含下面的对话历史），不然高亮会在中间断掉 */}
              <div className={`group rounded-lg ${isCurrent ? "bg-selected" : ""}`}>
                <div className={`${ROW} ${isCurrent ? "text-fg" : ""}`}>
                  {renaming?.path === path ? (
                    <>
                      <IconFolder />
                      {/* 就地改名：Enter 确认、Esc 取消、点别处也算确认 */}
                      <input
                        autoFocus
                        value={renaming.value}
                        onChange={(event) =>
                          setRenaming({ path, value: event.target.value })
                        }
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            renameWorkspace(path, renaming.value);
                          } else if (event.key === "Escape") {
                            event.preventDefault();
                            setRenaming(null);
                          }
                        }}
                        onBlur={() => renameWorkspace(path, renaming.value)}
                        placeholder={baseName(path)}
                        title="只改 CodeDock 里的显示名，不会改文件夹名"
                        className="min-w-0 flex-1 rounded border border-line bg-app px-1.5 py-0.5 text-[13px] text-fg outline-none placeholder:text-fg-faint focus:border-line-hover"
                      />
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => onSelect(path)}
                        title={toDisplayPath(path)}
                        className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                      >
                        <IconFolder />
                        <span className="truncate">{displayName(path)}</span>
                        {/* 已打开的项目在名字末尾点一个绿点：切到后台的也在后台跑着，一眼可辨 */}
                        {isOpen && (
                          <span
                            title="项目已打开"
                            className="h-1.5 w-1.5 shrink-0 rounded-full bg-ok"
                          />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={(event) => openMenu(path, event.currentTarget)}
                        title="更多操作"
                        className={ROW_ACTION}
                      >
                        <IconMore className="h-3.5 w-3.5" />
                      </button>
                      {/* 新建对话和折叠按钮贴在文件夹名右侧，只在当前项目且停在 GUI 时才出现 */}
                      {isCurrent && guiActive && (
                        <>
                          <button
                            type="button"
                            onClick={requestNew}
                            title="新建对话"
                            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-faint hover:bg-active hover:text-fg"
                          >
                            <IconPlus className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setHistoryOpen((open) => !open)}
                            title={historyOpen ? "收起对话历史" : "展开对话历史"}
                            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-faint hover:bg-active hover:text-fg"
                          >
                            {historyOpen ? (
                              <IconChevronDown className="h-3.5 w-3.5" />
                            ) : (
                              <IconChevronRight className="h-3.5 w-3.5" />
                            )}
                          </button>
                        </>
                      )}
                      {/* TUI 下同一个位置放 AI CLI 的入口：新开一个终端标签启动它。
                          配了多个命令时点「+」出菜单挑，只有一个就直接执行 */}
                      {isCurrent && !guiActive && (
                        <button
                          type="button"
                          onClick={(event) => launchAi(event.currentTarget)}
                          disabled={aiCommands.length === 0}
                          title={
                            aiCommands.length === 0
                              ? "还没配置 AI CLI 命令，去设置里加一个"
                              : "新开终端标签启动 AI CLI"
                          }
                          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-faint hover:bg-active hover:text-fg disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                        >
                          <IconPlus className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </>
                  )}
                </div>

                {/* 对话历史挂当前项目下，由文件夹行右侧的折叠按钮控制；点一条切到 GUI 并打开它 */}
                {isCurrent &&
                  guiActive &&
                  historyOpen &&
                  (sessions.length === 0 ? (
                    <p className="pr-2 pb-1 pl-[34px] text-[11px] text-fg-faint">还没有对话</p>
                  ) : (
                    <ul className="flex flex-col pb-1">
                      {sessions.map((item) => {
                        const isActive = item.id === currentId;
                        return (
                          <li
                            key={item.id}
                            className={`group/hist flex items-center rounded-md ${
                              isActive ? "bg-active" : "hover:bg-hover"
                            }`}
                          >
                            {renamingSession?.id === item.id ? (
                              /* 就地改名：Enter 确认、Esc 取消、点别处也算确认 */
                              <input
                                autoFocus
                                value={renamingSession.value}
                                onChange={(event) =>
                                  setRenamingSession({ id: item.id, value: event.target.value })
                                }
                                onKeyDown={(event) => {
                                  if (event.key === "Enter") {
                                    event.preventDefault();
                                    renameSession(item.id, renamingSession.value);
                                  } else if (event.key === "Escape") {
                                    event.preventDefault();
                                    setRenamingSession(null);
                                  }
                                }}
                                onBlur={() => renameSession(item.id, renamingSession.value)}
                                className="my-0.5 mr-2 ml-[34px] min-w-0 flex-1 rounded border border-line bg-app px-1.5 py-0.5 text-[12px] text-fg outline-none focus:border-line-hover"
                              />
                            ) : (
                              <>
                                <button
                                  type="button"
                                  onClick={() => requestSession(item.id)}
                                  title={item.title}
                                  className={`flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 pr-1 pl-[34px] text-left text-[12px] ${
                                    isActive
                                      ? "text-fg"
                                      : "text-fg-muted group-hover/hist:text-fg"
                                  }`}
                                >
                                  <span className="min-w-0 flex-1 truncate">{item.title}</span>
                                  {/* 时间只在没悬停时露脸：悬停后右侧让给「⋯」，两个都留会把标题挤没 */}
                                  <span className="shrink-0 text-[11px] text-fg-faint group-hover/hist:hidden">
                                    {formatTime(item.updated)}
                                  </span>
                                </button>
                                <button
                                  type="button"
                                  onClick={(event) => openHistMenu(item, event.currentTarget)}
                                  title="更多操作"
                                  className="pointer-events-none mr-1.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-faint opacity-0 hover:text-fg focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/hist:pointer-events-auto group-hover/hist:opacity-100"
                                >
                                  <IconMore className="h-3.5 w-3.5" />
                                </button>
                              </>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  ))}
              </div>
            </li>
          );
        })}
      </ul>

      {/* 当前 AI CLI 的会话历史。只在 TUI 下出现：GUI 那边项目行下面已经有
          opencode 自己的对话历史了，两套同时出现会打架 */}
      {current && !guiActive && aiCommands.length > 0 && (
        <CliHistory
          cwd={current}
          commands={aiCommands}
          value={activeCliCommand}
          onChange={pickCli}
          onResume={onResumeSession}
        />
      )}

      {/* 展开态两个按钮横着排：竖排要吃掉一截高度，白白挤掉下面项目列表的空间 */}
      <footer className="flex shrink-0 items-center gap-1 border-t border-line px-2 py-2">
        <button
          type="button"
          onClick={toggle}
          title={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
          className={FOOTER_BUTTON}
        >
          {theme === "dark" ? <IconSun /> : <IconMoon />}
        </button>
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          title="设置"
          className={FOOTER_BUTTON}
        >
          <IconSettings />
        </button>
        {/* 收起按钮跟着主题、设置一起沉到底部，头部只留标题 */}
        <button
          type="button"
          onClick={() => setCollapsedPersisted(true)}
          title="收起侧边栏"
          className={`${FOOTER_BUTTON} ml-auto`}
        >
          <IconPanelCollapse />
        </button>
      </footer>

      {settingsOpen && (
          <SettingsDialog onClose={() => setSettingsOpen(false)} cwd={current} />
        )}

      {/* 删除会话不可撤销，走自研确认框（三端一致，见 ConfirmDialog 的说明） */}
      {pendingDelete && (
        <ConfirmDialog
          message={`删除会话「${pendingDelete.title}」？这条对话的消息会一起删掉，不可撤销。`}
          confirmLabel="删除"
          onConfirm={() => {
            requestDelete(pendingDelete.id);
            setPendingDelete(null);
          }}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      {/* 项目行的「⋯」菜单。用 fixed 定位而不是绝对定位：项目列表是滚动容器，
          绝对定位的菜单会被 overflow 裁掉，靠窗口底部的项目就看不见菜单了 */}
      {menu && (
        <>
          {/* 铺一层透明遮罩接住外部点击 */}
          <div className="fixed inset-0 z-30" onClick={() => setMenu(null)} />
          <div
            className="fixed z-40 flex flex-col rounded border border-line-strong bg-raised py-1 shadow-lg"
            style={{
              width: MENU_W,
              left: menu.x - MENU_W,
              // 贴近窗口底部时往上收，别把菜单顶出可视区
              top: Math.min(menu.y + 4, window.innerHeight - 116),
            }}
          >
            <button
              type="button"
              onClick={() => openInSystem(menu.path)}
              className={MENU_ITEM}
            >
              打开
            </button>
            <button
              type="button"
              onClick={() => {
                const path = menu.path;
                setMenu(null);
                setRenaming({ path, value: displayName(path) });
              }}
              className={MENU_ITEM}
            >
              重命名
            </button>
            <button
              type="button"
              onClick={() => removeWorkspace(menu.path)}
              className={MENU_ITEM}
            >
              移除
            </button>
          </div>
        </>
      )}

      {/* 会话行的「⋯」菜单。同样 fixed 定位，理由见上面项目菜单 */}
      {histMenu && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setHistMenu(null)} />
          <div
            className="fixed z-40 flex flex-col rounded border border-line-strong bg-raised py-1 shadow-lg"
            style={{
              width: MENU_W,
              left: histMenu.x - MENU_W,
              top: Math.min(histMenu.y + 4, window.innerHeight - 72),
            }}
          >
            <button
              type="button"
              onClick={() => {
                const { item } = histMenu;
                setHistMenu(null);
                setRenamingSession({ id: item.id, value: item.title });
              }}
              className={MENU_ITEM}
            >
              重命名
            </button>
            <button
              type="button"
              onClick={() => {
                const { item } = histMenu;
                setHistMenu(null);
                setPendingDelete(item);
              }}
              className={MENU_ITEM}
            >
              删除对话
            </button>
          </div>
        </>
      )}

      {/* AI CLI 菜单。同样 fixed 定位，理由见上面项目菜单 */}
      {aiMenu && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setAiMenu(null)} />
          <div
            className="fixed z-40 flex flex-col rounded border border-line-strong bg-raised py-1 shadow-lg"
            style={{
              width: AI_MENU_W,
              left: aiMenu.x - AI_MENU_W,
              // 条数不定，按实际行数折算高度，免得贴底时被顶出可视区
              top: Math.min(aiMenu.y + 4, window.innerHeight - (aiCommands.length * 26 + 20)),
            }}
          >
            {aiCommands.map((item, index) => (
              <button
                key={`${item.name}-${item.command}-${index}`}
                type="button"
                onClick={() => {
                  setAiMenu(null);
                  pickCli(item.command);
                  onRunAiCommand(item.command);
                }}
                title={item.name || "未命名 AI CLI"}
                className={`${MENU_ITEM} flex items-center gap-2`}
              >
                <AgentLogo name={item.name} command={item.command} />
                <span className="truncate">{item.name || "未命名 AI CLI"}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
