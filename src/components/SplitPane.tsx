import { useCallback, useRef, useState, type ReactNode } from "react";

interface SplitPaneProps {
  first: ReactNode;
  second: ReactNode;
  /** 第一块占容器的百分比 */
  initial?: number;
  min?: number;
  max?: number;
}

export function SplitPane({ first, second, initial = 50, min = 15, max = 85 }: SplitPaneProps) {
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
        style={{ flexBasis: `${ratio}%`, flexGrow: 0, flexShrink: 0 }}
      >
        {first}
      </div>

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

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{second}</div>
    </div>
  );
}
