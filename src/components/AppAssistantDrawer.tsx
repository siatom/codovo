import {
  useImperativeHandle,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type Ref,
} from "react";
import type { EditorLocation } from "../lib/types";
import { AgentPane, type AgentPaneHandle } from "./AgentPane";

export interface AppAssistantDrawerHandle {
  /** 把一段位置引用插进助手的输入框（编辑器浮窗的「送给助手」用） */
  insertRef: (location: EditorLocation) => void;
}

interface AppAssistantDrawerProps {
  /** 抽屉是否展开。收起时只是滑出视口，面板本身不卸载——对话与滚动状态原样留着 */
  open: boolean;
  /** 助手服务对应的活动工作区根；没有工作区时为 null，整块不渲染 */
  root: string | null;
  onClose: () => void;
  /** React 19 起 ref 可以直接当普通 prop 传，不必再包 forwardRef */
  ref?: Ref<AppAssistantDrawerHandle>;
}

/** 窗口级偏好，存 sessionStorage：多窗口下各拖各的宽度 */
const WIDTH_KEY = "codedock.assistantWidth";

/** 默认宽度：够放一段对话和输入框，又不至于把中间的终端挤没 */
const DEFAULT_WIDTH = 460;

/** 再窄历史菜单和输入框就展不开了 */
const MIN_WIDTH = 320;

/** 上限还得看窗口：超过一半就快没地方给终端和编辑器了 */
const MAX_WIDTH = 760;

function clampWidth(value: number): number {
  const max = Math.min(MAX_WIDTH, Math.round(window.innerWidth / 2));
  return Math.min(max, Math.max(MIN_WIDTH, value));
}

function readWidth(): number {
  try {
    const raw = Number(window.sessionStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(raw) && raw > 0) return clampWidth(raw);
  } catch {
    // 读不到就用默认宽度
  }
  return clampWidth(DEFAULT_WIDTH);
}

/**
 * 应用助手的容器：从右缘滑出的抽屉（不属于右侧那七个模块）。
 *
 * 为什么是抽屉而不是弹窗：助手要**替你操作界面**——改设置、切右栏模块、开工作区。
 * 弹窗会把主界面整块盖住，看不到它改了什么；抽屉只占右缘一条，终端、文件树、编辑器
 * 都还看得见，改完哪块动了哪块一眼即可确认。
 *
 * 不用遮罩：抽屉开着时仍然要能点主界面（拖分栏、切标签）。关闭只走头部那颗按钮。
 */
export function AppAssistantDrawer({
  open,
  root,
  onClose,
  ref,
}: AppAssistantDrawerProps) {
  const [width, setWidth] = useState(readWidth);
  const paneRef = useRef<AgentPaneHandle>(null);
  /** 拖动中：记下起点，按像素差算宽度；null 表示没在拖 */
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [resizing, setResizing] = useState(false);

  // 编辑器浮窗送来的位置引用直接转给面板，由它插成 chip
  useImperativeHandle(
    ref,
    () => ({ insertRef: (location) => paneRef.current?.insertRef(location) }),
    [],
  );

  /**
   * 拖左边缘改宽度。走指针捕获而不是监听 window：指针移出这条细线后照样收得到事件。
   */
  const onResizeDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeRef.current = { startX: event.clientX, startWidth: width };
    setResizing(true);
    document.body.classList.add("codedock-dragging");
  };

  const onResizeMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = resizeRef.current;
    if (!drag) return;
    // 抽屉贴右缘，往左拖是变宽，位移取反
    setWidth(clampWidth(drag.startWidth + (drag.startX - event.clientX)));
  };

  const stopResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!resizeRef.current) return;
    resizeRef.current = null;
    setResizing(false);
    document.body.classList.remove("codedock-dragging");
    try {
      window.sessionStorage.setItem(WIDTH_KEY, String(width));
    } catch {
      // 记不住就下次还是默认宽度
    }
  };

  if (!root) return null;

  return (
    <aside
      // z-40：压在常规界面上，但低于设置 / 确认框那一层的 z-50，助手弹确认框不会被它盖住。
      // top-9：给自绘标题栏（36px）让位，否则抽屉一展开就把右上角的窗口按钮盖住。
      // 缓动和左右两侧栏共用 ease-dock；用 translate 做位移，不改 transform/布局
      className={`fixed top-9 bottom-0 right-0 z-40 flex flex-col border-l border-line bg-panel shadow-2xl transition-[translate] duration-300 ease-dock motion-reduce:transition-none ${
        open ? "translate-x-0" : "pointer-events-none translate-x-full"
      }`}
      style={{ width }}
      aria-hidden={!open}
      // 收起时连键盘焦点也一起挡住：只靠 pointer-events 的话，Tab 还能钻进看不见的输入框
      inert={!open}
    >
      {/* 左缘就是拖动条：视觉上一条细线，命中区加宽到 8px */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="拖动调整助手宽度"
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={stopResize}
        onPointerCancel={stopResize}
        className={`absolute inset-y-0 left-0 z-10 w-px cursor-col-resize transition-colors hover:bg-line-hover ${
          resizing ? "bg-accent-strong" : "bg-line-strong"
        }`}
      >
        <span className="absolute inset-y-0 -left-1 -right-1" />
      </div>

      {/* 按 root 给 key：切工作区时重建面板，让它按新工作区重新拉服务与历史 */}
      <AgentPane key={root} ref={paneRef} root={root} active={open} onClose={onClose} />
    </aside>
  );
}
