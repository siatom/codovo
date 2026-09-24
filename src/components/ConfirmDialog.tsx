import { useEffect } from "react";

interface ConfirmDialogProps {
  /** 要确认的事，一句话把后果说清楚 */
  message: string;
  /** 确认按钮的文案，用动词（「放弃」「删除」），别写成「确定」 */
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

const CANCEL_BUTTON =
  "rounded-md border border-line-strong px-3 py-1 text-[12px] text-fg-muted hover:bg-hover hover:text-fg";

/** 确认按钮用危险色描边：这一下按下去是不可撤销的 */
const CONFIRM_BUTTON =
  "rounded-md border border-danger-line px-3 py-1 text-[12px] text-danger hover:bg-danger-bg";

/**
 * 破坏性操作的确认框。外壳照设置面板那一套（遮罩 + 圆角卡片），
 * 点遮罩或按 Esc 都算取消。
 *
 * 刻意不用 `window.confirm`：WKWebView（macOS）不支持 `confirm` / `prompt`，
 * 调用会**静默失效**——不弹框、直接返回，用户根本不知道发生了什么。
 * wry 只在 Android 后端接管了脚本弹窗，三端桌面后端都没管。自己画一个最稳。
 */
export function ConfirmDialog({
  message,
  confirmLabel,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="w-[380px] max-w-full rounded-xl border border-line-strong bg-raised p-4 shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <p className="text-[12px] leading-relaxed text-fg">{message}</p>
        <div className="mt-4 flex justify-end gap-2">
          {/* 焦点默认落在取消上：破坏性操作不该让回车顺手确认掉 */}
          <button type="button" autoFocus onClick={onCancel} className={CANCEL_BUTTON}>
            取消
          </button>
          <button type="button" onClick={onConfirm} className={CONFIRM_BUTTON}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
