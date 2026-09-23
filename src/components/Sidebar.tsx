import { useState } from "react";
import { toDisplayPath } from "../lib/fs";
import type { GitSnapshot } from "../lib/git";
import { useTheme } from "../lib/theme";
import { SettingsDialog } from "./SettingsDialog";
import {
  IconBranch,
  IconClose,
  IconFolder,
  IconFolderPlus,
  IconMoon,
  IconPanelCollapse,
  IconPanelExpand,
  IconSettings,
  IconSun,
} from "./icons";

interface SidebarProps {
  /** 用过的目录，最近打开的排在最前 */
  workspaces: string[];
  /** 当前工作区；null 表示还没选 */
  current: string | null;
  /** 当前工作区的 git 状态 */
  git: GitSnapshot;
  onSelect: (path: string) => void;
  onAdd: () => void;
  /** 只从列表里去掉，不碰磁盘上的目录 */
  onRemove: (path: string) => void;
}

const COLLAPSED_KEY = "codedock.sidebarCollapsed";

/** 导航行的固定高度：展开态和收起态共用，来回切换时图标不会上下跳 */
const ROW_H = "h-[34px]";

/** 一行导航/列表项的统一样式，只靠调用处追加选中态 */
const ROW = `flex w-full ${ROW_H} items-center gap-2.5 rounded-lg px-2 text-left text-[13px] text-fg-muted hover:bg-hover hover:text-fg`;

const ICON_BUTTON =
  "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-dim hover:bg-hover hover:text-fg";

const FOOTER_BUTTON =
  "flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-fg-dim hover:bg-hover hover:text-fg";

/** 行内操作按钮：平时藏起来，悬停或键盘聚焦时才出现并接受点击 */
const ROW_ACTION =
  "pointer-events-none flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-faint opacity-0 hover:text-danger focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100";

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === "1";
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
  git,
  onSelect,
  onAdd,
  onRemove,
}: SidebarProps) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { theme, toggle } = useTheme();

  const setCollapsedPersisted = (next: boolean) => {
    setCollapsed(next);
    try {
      window.localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
    } catch {
      // 记不住就每次启动按展开算，不影响使用
    }
  };

  // 收起后留一个图标宽的竖条：常用入口（打开文件夹、主题）仍然够得着，
  // 顶上那个按钮负责展开。
  // 每段的上下留白都照展开态来（头部同高、导航行同高、底部同边距），
  // 这样来回切换时图标只横向挪位，不会上下跳。
  if (collapsed) {
    return (
      <div className="flex h-full w-11 shrink-0 flex-col border-r border-line bg-panel">
        <div className="flex h-11 shrink-0 items-center justify-center">
          <button
            type="button"
            onClick={() => setCollapsedPersisted(false)}
            title="展开侧边栏"
            className={ICON_BUTTON}
          >
            <IconPanelExpand />
          </button>
        </div>

        <div className="flex shrink-0 flex-col px-2 pb-1">
          <button
            type="button"
            onClick={onAdd}
            title="打开文件夹"
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
        </div>

        {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      </div>
    );
  }

  return (
    <div className="flex h-full w-60 shrink-0 flex-col border-r border-line bg-panel">
      <header className="flex h-11 shrink-0 items-center gap-1 px-2">
        <span className="min-w-0 flex-1 truncate px-2 text-[16px] font-semibold text-fg">
          CodeDock
        </span>
        <button
          type="button"
          onClick={() => setCollapsedPersisted(true)}
          title="收起侧边栏"
          className={ICON_BUTTON}
        >
          <IconPanelCollapse />
        </button>
      </header>

      <nav className="flex shrink-0 flex-col gap-0.5 px-2 pb-1">
        <button type="button" onClick={onAdd} className={ROW}>
          <IconFolderPlus />
          <span className="truncate">打开文件夹</span>
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
          return (
            <li key={path}>
              {/* 选中底色罩住整项（含下面的 git 行），不然高亮会在中间断掉 */}
              <div className={`group rounded-lg ${isCurrent ? "bg-selected" : ""}`}>
                <div className={`${ROW} ${isCurrent ? "text-fg" : ""}`}>
                  <button
                    type="button"
                    onClick={() => onSelect(path)}
                    title={toDisplayPath(path)}
                    className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                  >
                    <IconFolder />
                    <span className="truncate">{baseName(path)}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onRemove(path)}
                    title="从列表移除（不会删除文件夹）"
                    className={ROW_ACTION}
                  >
                    <IconClose className="h-3 w-3" />
                  </button>
                </div>

                {isCurrent && git.isRepo && (
                  <p className="flex items-center gap-1.5 pr-2 pb-1.5 pl-[34px] text-[11px] text-fg-faint">
                    <IconBranch className="h-3 w-3" />
                    <span className="min-w-0 truncate" title={git.branch ?? "游离 HEAD"}>
                      {git.branch ?? "游离 HEAD"}
                    </span>
                    {(git.ahead > 0 || git.behind > 0) && (
                      <span className="shrink-0" title="与上游分支的差距">
                        {git.ahead > 0 && `↑${git.ahead}`}
                        {git.ahead > 0 && git.behind > 0 && " "}
                        {git.behind > 0 && `↓${git.behind}`}
                      </span>
                    )}
                    {git.changed > 0 && (
                      <span className="shrink-0" title="未提交的改动条目数">
                        · {git.changed} 处改动
                      </span>
                    )}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <footer className="flex shrink-0 flex-col gap-1 border-t border-line px-2 py-2">
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
      </footer>

      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
