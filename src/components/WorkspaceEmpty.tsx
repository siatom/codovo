import appLogoRelease from "../../src-tauri/icons/128x128.png";
import appLogoDev from "../../src-tauri/icons/dev/128x128.png";
import { useActivityAll } from "../lib/activity";
import { pathKey, toDisplayPath } from "../lib/fs";
import { formatShortcut } from "../lib/shortcuts";
import { useSettings } from "../lib/settings";
import { useTheme } from "../lib/theme";
import type { Workspace } from "../lib/workspaces";
import {
  IconAlert,
  IconChevronRight,
  IconFile,
  IconFolderOpen,
  IconFolderPlus,
  IconMoon,
  IconPin,
  IconSettings,
  IconSun,
} from "./icons";

/** 和标题栏用同一份图标：dev 构建是琥珀橙那套，一眼分得清两个构建 */
const appLogo = import.meta.env.DEV ? appLogoDev : appLogoRelease;

interface WorkspaceEmptyProps {
  /** 启动恢复失败之类的提示，显示在操作按钮下方 */
  error: string | null;
  /** 列表里已有的工作区。即使一个都没打开，也让用户能从这里直接接着上次的活 */
  workspaces: Workspace[];
  /** 目录已失效的工作区根（按 `pathKey` 存），在卡片上先标出来 */
  missingRoots: ReadonlySet<string>;
  /** 新建工作区：走对话框，可以命名、加多个目录或克隆仓库 */
  onCreate: () => void;
  /** 打开已有工作区 */
  onOpen: (workspace: Workspace) => void;
  /** 直接挑一个 / 多个文件夹打开（最常用的一条路，做主按钮） */
  onOpenFolder: () => void;
  /** 打开任意文件；不在工作区里时按文件所在目录建一个 */
  onOpenFile: () => void;
  onOpenSettings: () => void;
}

/**
 * 一个工作区都没打开时的欢迎页。
 *
 * 这里刻意**铺满整个窗口**（此时侧栏不挂载）：第一次打开应用的人看到的应该是
 * 「这是干什么的、下一步点哪里」，而不是一块空面板加一句「从左侧列表打开」。
 * 已有的工作区按最近活动排出来，避免用户还得先意识到左边还有一份列表。
 */
export function WorkspaceEmpty({
  error,
  workspaces,
  missingRoots,
  onCreate,
  onOpen,
  onOpenFolder,
  onOpenFile,
  onOpenSettings,
}: WorkspaceEmptyProps) {
  const activityByRoot = useActivityAll();
  const { settings } = useSettings();
  const { theme, toggle } = useTheme();

  // 排序口径和侧栏一致：置顶固定在前，组内按终端 / 助手最近活动倒序。
  // 没记录过的算 0，sort 的稳定性会保持列表原有顺序（= 新建的在前）。
  const activityOf = (workspace: Workspace): number =>
    Math.max(0, ...workspace.roots.map((root) => activityByRoot[pathKey(root)] ?? 0));
  const ordered = [...workspaces].sort((a, b) => {
    const pin = Number(b.pinned === true) - Number(a.pinned === true);
    return pin !== 0 ? pin : activityOf(b) - activityOf(a);
  });

  return (
    <section className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-app">
      {/* 两团很淡的强调色光晕：给空窗口一点纵深，不引入图片资源，换主题也跟着走 */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute left-1/2 top-[-320px] h-[620px] w-[920px] -translate-x-1/2 rounded-full bg-accent/10 blur-[150px]" />
        <div className="absolute right-[-160px] bottom-[-260px] h-[480px] w-[480px] rounded-full bg-accent-strong/5 blur-[130px]" />
      </div>

      <div className="relative min-h-0 flex-1 overflow-auto">
        <div className="flex min-h-full items-center justify-center px-8 py-12">
          {/* codovo-tab-in 是现成的淡入上浮动画，prefers-reduced-motion 下会被关掉 */}
          <div className="codovo-tab-in w-full max-w-[820px] text-center">
            <img src={appLogo} alt="" className="mx-auto h-16 w-16 rounded-[18px] shadow-xl" />

            <div className="mt-5 flex items-baseline justify-center gap-2.5">
              <h1 className="text-[26px] font-semibold tracking-tight text-fg">Codovo</h1>
              <span className="text-[12px] font-medium tracking-[0.28em] text-fg-faint">码坞</span>
            </div>

            <p className="mt-3 text-[14px] text-fg-muted">把散落一地的开发现场，收拢进一个窗口。</p>
            <p className="mt-1.5 text-[12px] text-fg-faint">
              终端、编辑器、Git、远程、数据库、预览与部署，在同一片甲板上各就各位。
            </p>

            <div className="mt-8 flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                onClick={onOpenFolder}
                title="选择一个本地文件夹，直接作为工作区打开"
                className="flex h-10 items-center gap-2 rounded-lg bg-accent px-4 text-[13px] font-medium text-app shadow-[0_10px_30px_-14px_var(--c-accent)] transition hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                <IconFolderOpen className="h-4 w-4" />
                打开文件夹
              </button>
              <button
                type="button"
                onClick={onCreate}
                title="命名工作区、添加多个目录，或从 Git 仓库克隆"
                className="flex h-10 items-center gap-2 rounded-lg border border-line-strong bg-raised px-4 text-[13px] text-fg-muted transition-colors hover:border-line-hover hover:bg-hover hover:text-fg"
              >
                <IconFolderPlus className="h-4 w-4" />
                新建工作区
              </button>
              <button
                type="button"
                onClick={onOpenFile}
                title="打开任意文件；不在工作区里时，按文件所在目录建一个"
                className="flex h-10 items-center gap-2 rounded-lg px-3 text-[12px] text-fg-dim transition-colors hover:bg-hover hover:text-fg"
              >
                <IconFile className="h-4 w-4" />
                打开文件
                <kbd className="rounded border border-line-strong bg-surface px-1 py-px font-mono text-[10px] text-fg-faint">
                  {formatShortcut(settings.shortcuts["editor.openFile"])}
                </kbd>
              </button>
            </div>

            <p className="mt-3 text-[11px] text-fg-faint">也可以把文件夹或文件直接拖进窗口</p>

            {error && (
              <p className="mx-auto mt-4 max-w-md rounded-lg border border-danger-line bg-danger-bg px-3 py-1.5 text-[11px] text-danger">
                {error}
              </p>
            )}

            {ordered.length > 0 && (
              <div className="mt-10 text-left">
                <div className="mb-2.5 flex items-center gap-3">
                  <span className="shrink-0 text-[11px] font-medium tracking-[0.12em] text-fg-faint">
                    最近的工作区
                  </span>
                  <span className="h-px flex-1 bg-line" />
                </div>
                {/* 列表比窗口高时自己滚，不把整页顶长；能用完整窗口，也保证每个工作区都够得着 */}
                <div className="grid max-h-[34vh] gap-2 overflow-auto pr-0.5 sm:grid-cols-2">
                  {ordered.map((workspace) => {
                    const broken = workspace.roots.some((root) =>
                      missingRoots.has(pathKey(root)),
                    );
                    return (
                      <button
                        key={workspace.id}
                        type="button"
                        onClick={() => onOpen(workspace)}
                        className="group flex items-center gap-3 rounded-xl border border-line bg-panel px-3 py-2.5 text-left transition-colors hover:border-accent-line hover:bg-raised"
                      >
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface text-fg-dim transition-colors group-hover:text-accent-soft">
                          <IconFolderOpen className="h-4 w-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate text-[13px] text-fg">{workspace.name}</span>
                            {workspace.pinned && (
                              <IconPin className="h-3 w-3 shrink-0 text-fg-faint" />
                            )}
                            {broken && (
                              <span
                                title="工作目录不存在，点开会失败；打开后可用侧栏的「⋯」菜单编辑或移除"
                                className="shrink-0 text-warn"
                              >
                                <IconAlert className="h-3.5 w-3.5" />
                              </span>
                            )}
                          </span>
                          <span className="mt-0.5 block truncate text-[11px] text-fg-faint">
                            {workspace.roots.map((root) => toDisplayPath(root)).join("  ·  ")}
                          </span>
                        </span>
                        <IconChevronRight className="h-4 w-4 shrink-0 text-fg-faint opacity-0 transition-opacity group-hover:opacity-100" />
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 侧栏在这时整块不挂载，设置与主题入口跟着收到底部，不至于没处可点 */}
      <div className="relative flex shrink-0 items-center justify-center gap-1 pb-3 text-[11px] text-fg-faint">
        <button
          type="button"
          onClick={onOpenSettings}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors hover:bg-hover hover:text-fg"
        >
          <IconSettings className="h-3.5 w-3.5" />
          设置
        </button>
        <span className="h-3 w-px bg-line" />
        <button
          type="button"
          onClick={toggle}
          title={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors hover:bg-hover hover:text-fg"
        >
          {theme === "dark" ? (
            <IconSun className="h-3.5 w-3.5" />
          ) : (
            <IconMoon className="h-3.5 w-3.5" />
          )}
          {theme === "dark" ? "浅色主题" : "深色主题"}
        </button>
      </div>
    </section>
  );
}
