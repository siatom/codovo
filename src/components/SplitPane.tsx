import { useCallback, useRef, useState, type ReactNode } from "react";

interface SplitPaneProps {
  first: ReactNode;
  second: ReactNode;
  /** 第一块占容器的百分比 */
  initial?: number;
  min?: number;
  max?: number;
  /**
   * 收起第二块：不再占分栏宽度，改由它自己的内容撑开，分隔条也不画。
   * 右栏收起时第二块里只剩那条图标条，于是自然收成一条竖栏；
   * 其余内容仍然挂载（调用方用 hidden 藏起来），收起再展开不会把 Monaco 实例重建一遍。
   */
  secondCollapsed?: boolean;
  /**
   * 收起第一块，把整块地方让给第二块。全屏展示走的是这条路：
   * 终端得留着（PTY 在跑），所以同样是宽度归零而不是卸载。
   */
  firstCollapsed?: boolean;
}

export function SplitPane({
  first,
  second,
  initial = 50,
  min = 15,
  max = 85,
  secondCollapsed = false,
  firstCollapsed = false,
}: SplitPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [ratio, setRatio] = useState(initial);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
    document.body.classList.add("codedock-dragging");
  }, []);

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0) return;
      const next = ((event.clientX - rect.left) / rect.width) * 100;
      setRatio(Math.min(max, Math.max(min, next)));
    },
    [dragging, max, min],
  );

  const stop = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDragging(false);
    document.body.classList.remove("codedock-dragging");
  }, []);

  return (
    <div ref={containerRef} className="flex min-h-0 min-w-0 flex-1">
      <div
        className="flex min-h-0 min-w-0 flex-col overflow-hidden"
        style={
          // 第二块收起时没有别的兄弟去占位，第一块得自己撑满，否则右边留一片空白
          firstCollapsed
            ? { flexBasis: 0, flexGrow: 0, flexShrink: 0 }
            : secondCollapsed
              ? { flexBasis: 0, flexGrow: 1, flexShrink: 1 }
              : { flexBasis: `${ratio}%`, flexGrow: 0, flexShrink: 0 }
        }
      >
        {first}
      </div>

      {!secondCollapsed && !firstCollapsed && (
        <div
          role="separator"
          aria-orientation="vertical"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={stop}
          onPointerCancel={stop}
          className={`relative w-px shrink-0 cursor-col-resize bg-line-strong transition-colors ${
            dragging ? "bg-accent-strong" : "hover:bg-line-hover"
          }`}
        >
          {/* 加宽命中区，视觉上仍是一条细线 */}
          <span className="absolute inset-y-0 -left-1 -right-1" />
        </div>
      )}

      <div
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
        style={
          // 收起时按内容宽度收（flexBasis auto），不是归零——右栏里那条图标条得留着
          secondCollapsed ? { flexBasis: "auto", flexGrow: 0, flexShrink: 0 } : undefined
        }
      >
        {second}
      </div>
    </div>
  );
}
