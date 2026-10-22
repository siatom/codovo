import { useEffect, useState, type ReactNode } from "react";
import appLogoRelease from "../../src-tauri/icons/128x128.png";
import appLogoDev from "../../src-tauri/icons/dev/128x128.png";
import {
  closeWindow,
  isWindowMaximized,
  minimizeWindow,
  showWindowSystemMenu,
  toggleMaximizeWindow,
} from "../lib/window";

/** 直接复用 exe 打包用的那份图标；dev 构建用琥珀橙那套，和托盘 / 任务栏的区分一致 */
const appLogo = import.meta.env.DEV ? appLogoDev : appLogoRelease;

/**
 * 窗口按钮：46px 宽、整条标题栏高，悬停铺满底色——和系统标题栏的命中区一个手感。
 * 关闭键单独用危险色，避免和另外两个混在一起。
 */
const CONTROL =
  "flex w-[46px] items-center justify-center text-fg-dim transition-colors hover:bg-hover hover:text-fg";
const CONTROL_CLOSE = `${CONTROL} hover:bg-danger-bg hover:text-danger`;

/** 窗口按钮的图标统一 12×12 细线，比界面图标小一号 */
function ControlIcon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 12 12"
      className="h-3 w-3"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.1"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

interface TitleBarProps {
  /** 当前工作区名。没打开工作区时为 null，只显示应用名 */
  workspace: string | null;
}

/**
 * 自绘标题栏。系统标题栏已经去掉（`tauri.conf.json` 的 `decorations: false`），
 * 所以窗口那套动作得自己补：拖动、双击最大化、右键系统菜单、最小化 / 最大化 / 关闭。
 *
 * 拖动和双击最大化**交给系统**：带 `data-tauri-drag-region` 的元素由 Tauri 注入的脚本
 * 处理，走的是原生 `start_dragging` / `internal_toggle_maximize`，于是拖到屏幕顶部
 * 分屏、拖回还原、双击最大化这些行为都还在。自己用 mousemove 算位移做不出来这些。
 *
 * 标题栏本身按「栏」的配色（`--c-panel`），和左侧栏、右侧图标条同一色，
 * 中间内容区更深一档——沿用「不画竖线、靠深浅分区」那套。
 */
export function TitleBar({ workspace }: TitleBarProps) {
  const [maximized, setMaximized] = useState(false);

  /**
   * 最大化状态不只有按钮会改：拖拽贴边、Win+↑、右键菜单里的「最大化」都行。
   * 没有专门的窗口事件，就在尺寸变化后回问一次（拖动窗口边缘时 resize 会连发，
   * 所以加个短防抖，别把 IPC 打满）。
   */
  useEffect(() => {
    let alive = true;
    let timer = 0;
    const sync = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void isWindowMaximized()
          .then((value) => {
            if (alive) setMaximized(value);
          })
          .catch(() => {
            // 问不到就按当前图标继续，不值得打扰用户
          });
      }, 120);
    };
    sync();
    window.addEventListener("resize", sync);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      window.removeEventListener("resize", sync);
    };
  }, []);

  return (
    <div
      className="flex h-9 shrink-0 select-none items-center gap-2 bg-panel pl-3"
      // 空白处、logo、文字都是拖动区；按钮是 <button>，Tauri 的脚本会自己放行
      data-tauri-drag-region
      // 右键弹系统菜单：还原 / 移动 / 大小 / 最小化 / 最大化 / 关闭，
      // 菜单项状态（最大化时哪几项变灰）由系统自己维护
      onContextMenu={(event) => {
        event.preventDefault();
        void showWindowSystemMenu().catch(() => {
          // macOS / Linux 没有窗口系统菜单，右键不响应即可
        });
      }}
    >
      <img src={appLogo} alt="" className="h-4 w-4 shrink-0" data-tauri-drag-region />
      <span className="shrink-0 text-[12px] font-semibold text-fg-muted" data-tauri-drag-region>
        Codovo
      </span>
      {import.meta.env.DEV && (
        <span
          className="shrink-0 rounded border border-warn-line-strong px-1 text-[9px] font-medium leading-[13px] text-warn"
          data-tauri-drag-region
        >
          dev
        </span>
      )}
      {/* 工作区名跟在应用名后面。工作区恰好也叫 Codovo（本仓库自己就是）时不再重复一遍，
          左侧永远只有一个名字 */}
      {workspace && workspace !== "Codovo" && (
        <>
          <span className="shrink-0 text-[11px] text-fg-faint" data-tauri-drag-region>
            /
          </span>
          <span className="min-w-0 truncate text-[12px] text-fg-dim" data-tauri-drag-region>
            {workspace}
          </span>
        </>
      )}

      <div className="ml-auto flex h-full shrink-0 items-stretch">
        <button
          type="button"
          title="最小化"
          aria-label="最小化"
          onClick={() => void minimizeWindow().catch(() => {})}
          className={CONTROL}
        >
          <ControlIcon>
            <path d="M2.5 6h7" />
          </ControlIcon>
        </button>
        <button
          type="button"
          title={maximized ? "还原" : "最大化"}
          aria-label={maximized ? "还原" : "最大化"}
          onClick={() => {
            void toggleMaximizeWindow()
              .then((value) => setMaximized(value))
              .catch(() => {});
          }}
          className={CONTROL}
        >
          <ControlIcon>
            {maximized ? (
              <>
                <rect x="2" y="4" width="6" height="6" rx="0.5" />
                <path d="M4 4V2h6v6H8" />
              </>
            ) : (
              <rect x="2.5" y="2.5" width="7" height="7" rx="0.5" />
            )}
          </ControlIcon>
        </button>
        <button
          type="button"
          title="关闭"
          aria-label="关闭"
          onClick={() => void closeWindow().catch(() => {})}
          className={CONTROL_CLOSE}
        >
          <ControlIcon>
            <path d="m2.5 2.5 7 7M9.5 2.5l-7 7" />
          </ControlIcon>
        </button>
      </div>
    </div>
  );
}
