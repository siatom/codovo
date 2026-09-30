import {
  useCallback,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

/** 每个 pane 至少留这么多（百分比），拖到头也不会把邻居挤没 */
const MIN_PCT = 10;

/** row = 左右并排（拖竖线），column = 上下堆叠（拖横线） */
export type PaneAxis = "row" | "column";

function even(count: number): number[] {
  return Array.from({ length: count }, () => 100 / count);
}

/**
 * N 个 pane 沿一个轴的尺寸（百分比，总和恒为 100），相邻两个之间可拖。
 * 拖动只挪相邻这两个的比例，别的 pane 不受影响，所以不用重新归一化。
 *
 * 会话增删后旧比例对不上，直接在渲染期平分，比放进 effect 少一帧的错位。
 */
export function usePaneSizes(
  count: number,
  axis: PaneAxis,
  containerRef: RefObject<HTMLElement | null>,
) {
  const [stored, setStored] = useState<number[]>(() => even(count));
  const drag = useRef<{ index: number; start: number; base: number[] } | null>(null);
  const [dragging, setDragging] = useState(false);

  const sizes = stored.length === count ? stored : even(count);

  const onHandleDown = useCallback(
    (index: number, event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      // 走指针捕获：指针移出这条 1px 细线后照样收得到 move / up
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = {
        index,
        start: axis === "row" ? event.clientX : event.clientY,
        base: sizes,
      };
      setDragging(true);
      document.body.classList.add(axis === "row" ? "codedock-dragging" : "codedock-dragging-row");
    },
    [axis, sizes],
  );

  const onHandleMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const current = drag.current;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!current || !rect) return;
      const length = axis === "row" ? rect.width : rect.height;
      if (length <= 0) return;
      const pos = axis === "row" ? event.clientX : event.clientY;
      const delta = ((pos - current.start) / length) * 100;

      const { index, base } = current;
      const total = base[index] + base[index + 1];
      // 两个邻居加起来还不足 2×MIN 时，min 得往下让，否则 clamp 无解
      const min = Math.min(MIN_PCT, total / 2);
      const first = Math.min(total - min, Math.max(min, base[index] + delta));

      const next = [...base];
      next[index] = first;
      next[index + 1] = total - first;
      setStored(next);
    },
    [axis, containerRef],
  );

  const onHandleUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    drag.current = null;
    setDragging(false);
    document.body.classList.remove("codedock-dragging", "codedock-dragging-row");
  }, []);

  return { sizes, dragging, onHandleDown, onHandleMove, onHandleUp };
}
