import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

/** 按下后挪够这么多像素才算「在拖」，否则当普通点击（切换标签） */
const DRAG_THRESHOLD = 4;

/**
 * 横向标签栏的拖动重排。终端标签和编辑器标签结构一样（一个可滚动容器里排一排标签），
 * 差别只在「重排后往哪儿写」——终端写自己的 sessions，编辑器回调给父级改 openTabs，
 * 所以顺序的落盘交给调用方，这里只管指针状态机。
 *
 * 拖动从整行发起（标签很窄、行内还有关闭按钮，没有独立把手的位置）：pointerdown 只记
 * 起点，pointermove / pointerup 挂 window（指针一移出标签就断了），挪过阈值才真正进入
 * 拖动。落点按每个标签的 `getBoundingClientRect()` 现算，不依赖固定宽度——标签栏是横向
 * 滚动容器，宽度不固定。
 *
 * 调用方要做的：给每个标签加 `data-tab-item`（落点只认它们，避免把「+」按钮也算进去）、
 * 在滚动容器上挂 `onClickCapture`（吞掉拖完紧跟着的那次 click），并按 `dropIndex` 画落点线。
 */
export function useTabReorder(onReorder: (from: number, to: number) => void) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ from: number; startX: number; started: boolean } | null>(null);
  const [pending, setPending] = useState(false);
  /** 正在被拖的标签下标；null 表示没在拖 */
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  /** 落点空档的下标（0..n）；null 表示没在拖 */
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const dropRef = useRef<number | null>(null);
  /** 拖完浏览器会补一次 click，标记它让调用方吞掉，免得顺手又切一次标签 */
  const swallowClickRef = useRef(false);
  // 父组件每次渲染都会传新回调，进了依赖数组会反复解绑重挂，用 ref 兜住最新一份
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;

  /** 光标落在第几个空档：逐标签比中线，过了最后一个标签的中线就落到末尾 */
  const dropIndexAt = (clientX: number): number => {
    const tabs = scrollerRef.current?.querySelectorAll<HTMLElement>("[data-tab-item]");
    if (!tabs || tabs.length === 0) return 0;
    for (let i = 0; i < tabs.length; i += 1) {
      const rect = tabs[i].getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) return i;
    }
    return tabs.length;
  };

  /** 标签按下：只记起点，「到底在不在拖」交给 window 上的 pointermove 判 */
  const onTabDown = (index: number) => (event: ReactPointerEvent<HTMLElement>) => {
    // 只认鼠标左键：触摸的横向拖动要留给标签栏滚动
    if (event.button !== 0 || event.pointerType !== "mouse") return;
    // 关闭按钮不参与拖动，否则想关标签会变成拖行
    if ((event.target as HTMLElement).closest("[data-tab-close]")) return;
    swallowClickRef.current = false;
    dragRef.current = { from: index, startX: event.clientX, started: false };
    setPending(true);
  };

  useEffect(() => {
    if (!pending) return;
    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (!drag.started) {
        if (Math.abs(event.clientX - drag.startX) < DRAG_THRESHOLD) return;
        drag.started = true;
        // 按下到越界这几像素里可能已经选上了文本，清掉
        window.getSelection()?.removeAllRanges();
        document.body.classList.add("codedock-dragging-list");
        setDragFrom(drag.from);
      }
      const index = dropIndexAt(event.clientX);
      dropRef.current = index;
      setDropIndex(index);
    };
    const finish = (commit: boolean) => {
      const drag = dragRef.current;
      dragRef.current = null;
      setPending(false);
      setDragFrom(null);
      setDropIndex(null);
      document.body.classList.remove("codedock-dragging-list");
      const index = dropRef.current;
      dropRef.current = null;
      // 按下了但没挪过，那就是普通点击，什么都不用做
      if (!drag?.started) return;
      swallowClickRef.current = true;
      if (!commit || index === null) return;

      // 落点下标数的是「空档」，抽走源项后它后面的空档会左移一格
      const insertAt = index > drag.from ? index - 1 : index;
      if (insertAt === drag.from) return;
      onReorderRef.current(drag.from, insertAt);
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  }, [pending]);

  /** 挂在滚动容器上：拖完那一次 click 直接拦掉，别触发标签切换 / 关闭 */
  const onClickCapture = (event: ReactMouseEvent<HTMLElement>) => {
    if (!swallowClickRef.current) return;
    swallowClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  };

  return { scrollerRef, dragFrom, dropIndex, onTabDown, onClickCapture };
}
