import { useEffect } from "react";
import { IconAlert, IconClose } from "./icons";

interface ToastProps {
  /** 提示正文，一句话把发生了什么说清楚 */
  message: string;
  onClose: () => void;
}

/** 自动消失时间。错误信息常带路径、要读几秒，太短了还没看清就没了 */
const DURATION = 6000;

/**
 * 右下角的操作反馈条。目前只用来报「打开失效工作区失败」这类错误，所以固定危险色。
 *
 * 刻意不用 `window.alert`：WKWebView 静默失效（理由同 ConfirmDialog），
 * 也不能像这样不打断操作地飘在角落。
 */
export function Toast({ message, onClose }: ToastProps) {
  useEffect(() => {
    const timer = window.setTimeout(onClose, DURATION);
    return () => window.clearTimeout(timer);
    // message 变了要重新计时：连续两条错误不该被上一条的计时提前关掉
  }, [message, onClose]);

  return (
    <div
      role="alert"
      className="fixed right-4 bottom-4 z-50 flex max-w-[380px] items-start gap-2 rounded-lg border border-danger-line bg-danger-bg px-3 py-2 text-[12px] leading-relaxed text-danger shadow-lg"
    >
      <IconAlert className="mt-0.5 h-3.5 w-3.5" />
      <span className="min-w-0 flex-1 break-words">{message}</span>
      <button
        type="button"
        onClick={onClose}
        title="关闭"
        className="-mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded opacity-70 hover:opacity-100"
      >
        <IconClose className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
