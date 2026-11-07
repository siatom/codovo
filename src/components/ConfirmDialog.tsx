import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { tabbable } from "tabbable";

interface ConfirmDialogProps {
  /** 要确认的事，一句话把后果说清楚 */
  message: string;
  /** 确认按钮的文案，用动词（「放弃」「删除」），别写成「确定」 */
  confirmLabel: string;
  /**
   * 取消按钮的文案，默认「取消」。当取消位上其实是个有意义的动作时改这里
   * （关窗口那处，「取消」= 「最小化到托盘」）
   */
  cancelLabel?: string;
  /**
   * 可选的第三个按钮（如关闭脏标签时的「不保存」），位置在取消与确认之间。
   * 给了文案就必须给 `onSecondary`，否则它点了没反应。
   */
  secondaryLabel?: string;
  onSecondary?: (checked: boolean) => void;
  /**
   * 确认按钮是否用危险色（默认 true，因为多数场景是不可撤销的破坏性操作）。
   * 「保存」这类非破坏性动作传 false，免得看着像要删东西。
   */
  danger?: boolean;
  /** 正文下方的自定义内容（如删除弹窗里「回收站 / 永久删除」的二选一） */
  children?: ReactNode;
  /** 有值时在正文下方多一个勾选框，勾没勾跟着确认 / 取消一起回传 */
  checkboxLabel?: string;
  /** `checked` 只在给了 `checkboxLabel` 时才有意义，否则恒为 false */
  onConfirm: (checked: boolean) => void;
  onCancel: (checked: boolean) => void;
  /**
   * 点遮罩 / 按 Esc（即「反悔、什么都不做」）的行为，不给就回退到 `onCancel`。
   * 取消位是个有意义的动作时必须单独给（关窗口那处取消 = 最小化到托盘），
   * 否则用户想反悔时会被顺手最小化掉。
   */
  onDismiss?: (checked: boolean) => void;
}

const CANCEL_BUTTON =
  "rounded-md border border-line-strong px-3 py-1 text-[12px] text-fg-muted hover:bg-hover hover:text-fg";

/** 确认按钮用危险色描边：这一下按下去是不可撤销的 */
const CONFIRM_BUTTON =
  "rounded-md border border-danger-line px-3 py-1 text-[12px] text-danger hover:bg-danger-bg";

/** 非破坏性确认（如「保存」）用强调色，别让用户误以为要删东西 */
const PRIMARY_BUTTON =
  "rounded-md border border-accent-line px-3 py-1 text-[12px] text-accent-soft hover:bg-active";

/** 中间那个「有意义的第三个选择」（如「不保存」）：比取消更醒目一点 */
const SECONDARY_BUTTON =
  "rounded-md border border-line-strong px-3 py-1 text-[12px] text-fg hover:bg-active";

/**
 * 破坏性操作的确认框。外壳照设置面板那一套（遮罩 + 圆角卡片），
 * 点遮罩或按 Esc 都算「反悔」（走 `onDismiss`，默认等同取消）。
 *
 * 刻意不用 `window.confirm`：WKWebView（macOS）不支持 `confirm` / `prompt`，
 * 调用会**静默失效**——不弹框、直接返回，用户根本不知道发生了什么。
 * wry 只在 Android 后端接管了脚本弹窗，三端桌面后端都没管。自己画一个最稳。
 */
export function ConfirmDialog({
  message,
  confirmLabel,
  cancelLabel = "取消",
  secondaryLabel,
  onSecondary,
  danger = true,
  children,
  checkboxLabel,
  onConfirm,
  onCancel,
  onDismiss,
}: ConfirmDialogProps) {
  const [checked, setChecked] = useState(false);

  // 点遮罩 / 按 Esc 走这条；没单独给就回退到取消（大多数场景两者等价）
  const dismiss = onDismiss ?? onCancel;

  const titleId = useId();
  const messageId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const trigger = document.activeElement;
    const ancestors: HTMLElement[] = [];
    for (
      let node = trigger?.parentElement;
      node && node !== document.body;
      node = node.parentElement
    ) {
      ancestors.push(node);
    }

    // 原生模态层让背景不可交互，也负责多个确认框的叠放顺序。
    dialog.showModal();
    cancelRef.current?.focus({ preventScroll: true });

    return () => {
      dialog.close();
      // 浏览器通常会把焦点还给触发控件；等 React 移除旧标签等节点后再兜底。
      queueMicrotask(() => {
        if (document.activeElement && document.activeElement !== document.body)
          return;
        if (trigger instanceof HTMLElement && trigger.isConnected) {
          trigger.focus({ preventScroll: true });
          if (document.activeElement === trigger) return;
        }
        for (const modal of document.querySelectorAll<HTMLDialogElement>(
          "dialog:modal",
        )) {
          tabbable(modal)[0]?.focus({ preventScroll: true });
          if (modal.contains(document.activeElement)) return;
        }
        const root = document.getElementById("root");
        if (root) ancestors.push(root);
        for (const node of ancestors) {
          if (!node.isConnected || !node.getClientRects().length) continue;
          const temporary = !node.hasAttribute("tabindex");
          if (temporary) node.tabIndex = -1;
          node.focus({ preventScroll: true });
          if (document.activeElement === node) {
            // 移除 tabindex 会让部分 WebView 立即丢掉焦点，等用户离开再还原。
            if (temporary)
              node.addEventListener(
                "blur",
                () => {
                  if (node.getAttribute("tabindex") === "-1")
                    node.removeAttribute("tabindex");
                },
                { once: true },
              );
            return;
          }
          if (temporary) node.removeAttribute("tabindex");
        }
      });
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={messageId}
      className="codovo-modal-scrim fixed inset-0 m-0 h-auto w-auto max-h-none max-w-none items-center justify-center bg-black/40 p-6 open:flex backdrop:bg-transparent"
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        dismiss(checked);
      }}
      onKeyDown={(event) => {
        // 不让 Esc 等按键冒泡到背景的设置面板、全屏区和助手抽屉。
        event.stopPropagation();
        if (event.defaultPrevented || event.nativeEvent.isComposing) return;
        if (event.key === "Escape") {
          event.preventDefault();
          dismiss(checked);
        } else if (event.key === "Tab") {
          event.preventDefault();
          const stops = tabbable(event.currentTarget);
          if (!stops.length) return;
          const index = stops.findIndex(
            (node) => node === document.activeElement,
          );
          const next =
            index < 0
              ? event.shiftKey
                ? stops.length - 1
                : 0
              : (index + (event.shiftKey ? -1 : 1) + stops.length) %
                stops.length;
          stops[next].focus();
        }
      }}
      // 认「按下点就在遮罩上」而不是 click：click 会派发到 mousedown/mouseup 的共同
      // 祖先，从弹窗内按下、拖到遮罩上松开也会误判成点外部
      onMouseDown={(event) => {
        if (event.button === 0 && event.target === event.currentTarget) {
          event.preventDefault();
          dismiss(checked);
        }
      }}
    >
      <div
        className="w-[380px] max-w-full rounded-xl border border-line-strong bg-raised p-4 shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id={titleId} className="sr-only">
          确认操作：{confirmLabel}
        </h2>
        <p id={messageId} className="text-[12px] leading-relaxed text-fg">
          {message}
        </p>
        {children}
        {checkboxLabel && (
          <label className="mt-3 flex cursor-pointer items-center gap-2 text-[12px] text-fg-muted">
            <input
              type="checkbox"
              checked={checked}
              onChange={(event) => setChecked(event.target.checked)}
              className="accent-accent"
            />
            {checkboxLabel}
          </label>
        )}
        <div className="mt-4 flex justify-end gap-2">
          {/* 焦点默认落在取消上：破坏性操作不该让回车顺手确认掉 */}
          <button
            type="button"
            ref={cancelRef}
            onClick={() => onCancel(checked)}
            className={CANCEL_BUTTON}
          >
            {cancelLabel}
          </button>
          {secondaryLabel && (
            <button
              type="button"
              onClick={() => onSecondary?.(checked)}
              className={SECONDARY_BUTTON}
            >
              {secondaryLabel}
            </button>
          )}
          <button
            type="button"
            onClick={() => onConfirm(checked)}
            className={danger ? CONFIRM_BUTTON : PRIMARY_BUTTON}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
