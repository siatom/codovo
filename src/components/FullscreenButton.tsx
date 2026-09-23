import { IconFullscreen, IconFullscreenExit } from "./icons";

interface FullscreenButtonProps {
  /** 当前是否全屏：决定图标和标题 */
  fullscreen: boolean;
  onToggle: () => void;
}

/**
 * 三个模块（文件/变更/浏览器）标题栏右端共用的全屏开关。
 * 全屏 = 整个右边栏铺满窗口，侧边栏和终端让位；该模块内部的分栏照旧。
 */
export function FullscreenButton({ fullscreen, onToggle }: FullscreenButtonProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={fullscreen ? "退出全屏（Esc）" : "全屏展示"}
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-dim hover:bg-active hover:text-fg"
    >
      {fullscreen ? (
        <IconFullscreenExit className="h-3.5 w-3.5" />
      ) : (
        <IconFullscreen className="h-3.5 w-3.5" />
      )}
    </button>
  );
}
