import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

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
  /**
   * 双击分隔条把两块复位成均分（各 50%，受 min/max 约束）。
   * 默认关闭：只有「终端 / 右边栏」这条主分栏需要它——内层文件栏的 max 不到 50，
   * 均分在那里落不下去。
   */
  resetOnDoubleClick?: boolean;
  /**
   * 第一块按**像素宽度**记，而不是容器百分比。容器变宽 / 变窄（右栏全屏、拖窗口边缘、
   * 拖外层分隔条）时第一块宽度保持不动，增减的宽度全落到第二块；只有拖动本条分隔条
   * 才会改第一块的宽度。右栏里的「文件/变更 : 编辑器」走这个，全屏时侧栏不会跟着翻倍。
   */
  keepFirstWidth?: boolean;
  /**
   * 第二块收起 / 展开时用宽度动画过渡（主分栏的右边栏用）。收起后的宽度由
   * `collapsedSecondWidth` 指定——第二块里还留着一条图标栏，不能归零。
   * 动画只改 flex-basis：窗口本身缩放时百分比不变，不会像按帧量宽那样拖泥带水。
   */
  animateCollapse?: boolean;
  /** 收起态第二块的像素宽度，只在 animateCollapse 时生效（右侧图标条 w-11 = 44） */
  collapsedSecondWidth?: number;
}

export function SplitPane({
  first,
  second,
  initial = 50,
  min = 15,
  max = 85,
  secondCollapsed = false,
  firstCollapsed = false,
  resetOnDoubleClick = false,
  keepFirstWidth = false,
  animateCollapse = false,
  collapsedSecondWidth = 0,
}: SplitPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [ratio, setRatio] = useState(initial);
  /**
   * 第一块的像素宽度，只在 keepFirstWidth 时用。先按 initial 折算一次，之后不再跟着
   * 容器缩放——百分比写法下容器一宽，侧栏就跟着变宽，全屏时尤其明显。
   */
  const [firstWidth, setFirstWidth] = useState<number | null>(null);
  /** firstWidth 的最新值。ResizeObserver 回调里判断「有没有量过」，避免依赖 state 的旧闭包 */
  const firstWidthRef = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);

  // 右栏收起 / 停在浏览器等模块时容器宽度是 0，只能等它真正有宽度了再折算像素值。
  // 折算只做一次：之后容器再怎么变都由第二块吃掉，第一块的宽度归用户拖。
  useEffect(() => {
    if (!keepFirstWidth) return;
    const element = containerRef.current;
    if (!element) return;
    /**
     * 首次量宽可能正赶上右栏的展开动画（宽度每帧都在变），第一帧取到的是中间值，
     * 折算出来会让侧栏永远只有几像素。等宽度稳定 160ms 后再落定；量过之后不再更新。
     */
    let settle: number | null = null;
    const observer = new ResizeObserver(() => {
      if (settle !== null) {
        window.clearTimeout(settle);
        settle = null;
      }
      const width = element.getBoundingClientRect().width;
      if (width <= 0 || firstWidthRef.current !== null) return;
      settle = window.setTimeout(() => {
        settle = null;
        if (firstWidthRef.current !== null) return;
        const measured = element.getBoundingClientRect().width;
        if (measured <= 0) return;
        const next = (measured * initial) / 100;
        firstWidthRef.current = next;
        setFirstWidth(next);
      }, 160);
    });
    observer.observe(element);
    return () => {
      if (settle !== null) window.clearTimeout(settle);
      observer.disconnect();
    };
  }, [keepFirstWidth, initial]);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
    document.body.classList.add("codovo-dragging");
  }, []);

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0) return;
      // 两套写法共用同一份 min/max（容器百分比），只是落点一个是像素、一个是比例
      const next = Math.min(
        (rect.width * max) / 100,
        Math.max((rect.width * min) / 100, event.clientX - rect.left),
      );
      if (keepFirstWidth) {
        firstWidthRef.current = next;
        setFirstWidth(next);
        return;
      }
      setRatio((next / rect.width) * 100);
    },
    [dragging, keepFirstWidth, max, min],
  );

  /** 双击复位：均分，但仍在 min/max 允许的区间内 */
  const resetRatio = useCallback(() => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (keepFirstWidth && rect && rect.width > 0) {
      const next = (rect.width * Math.min(max, Math.max(min, 50))) / 100;
      firstWidthRef.current = next;
      setFirstWidth(next);
      return;
    }
    setRatio(Math.min(max, Math.max(min, 50)));
  }, [keepFirstWidth, max, min]);

  const stop = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDragging(false);
    document.body.classList.remove("codovo-dragging");
  }, []);

  return (
    <div ref={containerRef} className="flex min-h-0 min-w-0 flex-1">
      <div
        className="flex min-h-0 min-w-0 flex-col overflow-hidden"
        style={
          // 第二块收起时没有别的兄弟去占位，第一块得自己撑满，否则右边留一片空白。
          // 有动画时同理：第二块从百分比落到图标条宽度，第一块一路 grow 吃掉差额
          firstCollapsed
            ? { flexBasis: 0, flexGrow: 0, flexShrink: 0 }
            : animateCollapse || secondCollapsed
              ? { flexBasis: 0, flexGrow: 1, flexShrink: 1 }
              : keepFirstWidth
                ? {
                    // 还没量到宽度时先用百分比顶一下，避免首帧闪一下
                    flexBasis: firstWidth === null ? `${ratio}%` : `${firstWidth}px`,
                    flexGrow: 0,
                    flexShrink: 0,
                    // 容器被拖得很窄时用 max 兜底，别让侧栏把编辑器挤没。
                    // 容器重新变宽后上限跟着变大，侧栏自动回到用户拖出来的宽度
                    maxWidth: `${max}%`,
                  }
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
          onDoubleClick={resetOnDoubleClick ? resetRatio : undefined}
          className="relative w-0 shrink-0 cursor-col-resize"
        >
          {/* 分隔处不画常驻竖线：两侧靠背景深浅区分（侧栏 panel 比中间 surface 亮）。
              这里只留一条加宽的命中区，悬停 / 拖动时才浮出一条窄带提示分界在哪 */}
          <span
            className={`absolute inset-y-0 -left-1 -right-1 transition-colors ${
              dragging ? "bg-accent-strong/50" : "hover:bg-line-hover/35"
            }`}
          />
        </div>
      )}

      <div
        className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${
          // 拖动中不做过渡：每帧都改 flex-basis，跟上指针才不会有橡皮筋感
          animateCollapse && !dragging ? "codovo-split-anim" : ""
        }`}
        style={
          // 收起时按内容宽度收（flexBasis auto），不是归零——右栏里那条图标条得留着。
          // 有动画时落到约定的图标条宽度；展开回到「剩余比例」，百分比让窗口缩放保持跟手。
          // firstCollapsed（右栏全屏）时第二块仍然 flex-1 铺满，走最下面那支
          firstCollapsed
            ? undefined
            : animateCollapse
              ? {
                  flexBasis: secondCollapsed ? `${collapsedSecondWidth}px` : `${100 - ratio}%`,
                  flexGrow: 0,
                  flexShrink: 0,
                }
              : secondCollapsed
                ? { flexBasis: "auto", flexGrow: 0, flexShrink: 0 }
                : undefined
        }
      >
        {second}
      </div>
    </div>
  );
}
