import { useRef, useState } from "react";

/** 键盘上下键调高度时每一档的像素 */
const KEY_STEP = 24;

interface LogResizeHandleProps {
  /** 当前日志区高度（px），由调用方持有，方便一并做持久化 */
  height: number;
  /** 下限 */
  min: number;
  /**
   * 上限。拖动过程中现算：面板高度会变，上方配置区展开也会吃掉空间，
   * 写死一个数迟早把另一块挤没。
   */
  max: () => number;
  onChange: (height: number) => void;
  /** 松手 / 键盘调完时调用，通常用来把高度写进 sessionStorage */
  onCommit: (height: number) => void;
  /** 双击复位 */
  onReset: () => void;
}

/**
 * 日志区和上方内容之间的拖动条。
 *
 * 指针捕获 + body 挂 `codovo-dragging-row`，和 GitChangesPane 的时间线是同一套写法：
 * 指针拖出这条 1px 的细线后照样收得到事件，拖动期间全局禁选中、光标保持 row-resize。
 * 条在日志区上方，所以「往上拖」是把日志区拉高（`start.height - delta`）。
 */
export function LogResizeHandle({
  height,
  min,
  max,
  onChange,
  onCommit,
  onReset,
}: LogResizeHandleProps) {
  const startRef = useRef<{ y: number; height: number } | null>(null);
  /** 拖动 / 键盘连续改高度时，父组件的 state 还没走到这一帧，先自己记最新的 */
  const latestRef = useRef(height);
  latestRef.current = height;
  const [dragging, setDragging] = useState(false);

  const clamp = (next: number) => {
    const limit = Math.max(min, max());
    return Math.min(limit, Math.max(min, next));
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    startRef.current = { y: event.clientY, height };
    setDragging(true);
    document.body.classList.add("codovo-dragging-row");
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = startRef.current;
    if (!start) return;
    const next = clamp(start.height - (event.clientY - start.y));
    if (next === latestRef.current) return;
    latestRef.current = next;
    onChange(next);
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!startRef.current) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    startRef.current = null;
    setDragging(false);
    document.body.classList.remove("codovo-dragging-row");
    onCommit(latestRef.current);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // 条在日志区上方：ArrowUp 把日志拉高
    const delta = event.key === "ArrowUp" ? KEY_STEP : event.key === "ArrowDown" ? -KEY_STEP : 0;
    if (delta === 0) return;
    event.preventDefault();
    const next = clamp(latestRef.current + delta);
    latestRef.current = next;
    onChange(next);
    onCommit(next);
  };

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      tabIndex={0}
      aria-valuenow={height}
      aria-valuemin={min}
      aria-valuemax={Math.max(min, max())}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
      title="拖动调整日志高度，双击复位"
      className={`relative h-px shrink-0 cursor-row-resize transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-strong ${
        dragging ? "bg-accent-strong" : "bg-line-strong hover:bg-line-hover"
      }`}
    >
      {/* 加宽命中区，视觉上仍是一条细线 */}
      <span className="absolute inset-x-0 -top-1 -bottom-1" />
    </div>
  );
}

/** 读回某个工作目录上次拖出来的日志高度 */
export function readStoredLogHeight(
  key: string,
  min: number,
  max: number,
  fallback: number,
): number {
  try {
    const saved = Number(window.sessionStorage.getItem(key));
    if (Number.isFinite(saved) && saved >= min && saved <= max) return saved;
  } catch {
    // 读不到就用默认值
  }
  return fallback;
}

/** 记住日志高度。记不住不影响使用，下次回到默认高度 */
export function writeStoredLogHeight(key: string, height: number): void {
  try {
    window.sessionStorage.setItem(key, String(height));
  } catch {
    // 忽略
  }
}
