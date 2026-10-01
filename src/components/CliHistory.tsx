import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { formatTime } from "../lib/agent";
import {
  CLI_PROVIDERS,
  cliProvider,
  listCliSessions,
  resumeCommand,
} from "../lib/cli-sessions";
import type { AiCommand } from "../lib/settings";
import type { CliSessionInfo } from "../lib/types";
import {
  AgentLogo,
  IconChevronDown,
  IconChevronRight,
} from "./icons";

interface CliHistoryProps {
  /** 当前工作区。只列落在这个目录里的会话 */
  cwd: string;
  /** settings.aiCommands 过滤后的列表 */
  commands: AiCommand[];
  /** 当前选中的命令行 */
  value: string;
  onChange: (command: string) => void;
  /** 点一条会话：参数是拼好的完整 resume 命令，以及该会话的标题（作新标签的标题） */
  onResume: (command: string, title: string) => void;
}

/** 选择器菜单宽度（px）。比工作区行的菜单宽：名字前面多一个 logo */
const CLI_MENU_W = 160;

const CLI_MENU_ITEM =
  "flex items-center gap-2 px-3 py-1 text-left text-[12px] text-fg-muted hover:bg-hover hover:text-fg";

const HINT = "px-2 py-1 text-[11px] text-fg-faint";

/** 列表高度是窗口级偏好，存 sessionStorage：多窗口下各拖各的 */
const HEIGHT_KEY = "codedock.cliHistoryHeight";

/** 自动刷新间隔。列表是 CLI 自己写在磁盘上的，界面不知道它什么时候变 */
const POLL_MS = 20000;

/** 列表区能拖到多高/多矮；默认值就是改动前写死的 max-h-56（224px） */
const MIN_HEIGHT = 80;
const MAX_HEIGHT = 600;
const DEFAULT_HEIGHT = 224;

/** 上面至少要留出来的高度：侧边栏标题 + 新建工作区 + 工作区列表两三行 */
const RESERVED_ABOVE = 200;

function readHeight(): number {
  try {
    const saved = Number(window.sessionStorage.getItem(HEIGHT_KEY));
    if (Number.isFinite(saved) && saved >= MIN_HEIGHT && saved <= MAX_HEIGHT) {
      return saved;
    }
  } catch {
    // 读不到就用默认值
  }
  return DEFAULT_HEIGHT;
}

/**
 * 侧边栏底部的「当前 AI CLI 的会话历史」。
 *
 * 数据来自 CLI 自己写在磁盘上的会话记录（后端 cli_list_sessions），点一条就新开
 * 一个终端标签跑 resume。只在终端（TUI）模式下出现——GUI 那边工作区行下面已经有
 * opencode 自己的对话历史，两套同时出现会打架。
 */
export function CliHistory({
  cwd,
  commands,
  value,
  onChange,
  onResume,
}: CliHistoryProps) {
  const [open, setOpen] = useState(true);
  const [items, setItems] = useState<CliSessionInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 手动刷新用：加一就重跑下面的 effect */
  const [nonce, setNonce] = useState(0);
  /** 本次刷新是不是自动触发的；是的话不显示加载态（见下面的 effect） */
  const pollRef = useRef(false);
  /** 选择器菜单的位置，fixed 定位 */
  const [picker, setPicker] = useState<{ x: number; y: number } | null>(null);
  /** 列表区高度，可拖上边缘改 */
  const [height, setHeight] = useState(readHeight);
  const [dragging, setDragging] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  /** 按下时的起点：拖动中每次移动都拿它算位移，避免依赖 state 的旧值 */
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);

  const current = commands.find((item) => item.command === value);
  const provider = cliProvider(value, current?.name ?? "");
  const providerKey = provider?.key ?? "";

  // 切工作区 / 换 CLI / 展开 / 自动刷新都走这里
  useEffect(() => {
    // 自动刷新不显示加载态：列表本来就有内容，每 20 秒让刷新按钮转一下太吵。
    // 先消费掉标记，免得被折叠 / 切工作区这些早退路径留在原地
    const silent = pollRef.current;
    pollRef.current = false;
    // 折叠着就别去读盘了
    if (!providerKey || !open) {
      setItems([]);
      setError(null);
      return;
    }
    let cancelled = false;
    if (!silent) setLoading(true);
    // value 传的是命令本身：opencode 那一支要用它去起 CLI
    listCliSessions(providerKey, cwd, value)
      .then((list) => {
        if (cancelled) return;
        setItems(list);
        setError(null);
      })
      .catch((reason) => {
        if (cancelled) return;
        setItems([]);
        setError(String(reason));
      })
      .finally(() => {
        // 静默刷新时它本来就是 false，重置一次无副作用
        if (!cancelled) setLoading(false);
      });
    // 丢掉作废请求的迟到结果（换工作区后旧的慢请求可能后回来）
    return () => {
      cancelled = true;
    };
  }, [cwd, providerKey, value, open, nonce]);

  /**
   * 自动刷新。CLI 的会话记录由它自己写盘，界面无从得知何时变了，所以自己拉：
   * 窗口可见时定时拉一次，切回窗口时立刻拉一次（用户多半刚在别处跑完 CLI）。
   *
   * 只在展开时跑，且定时那一支要求窗口可见——最小化后还每 20 秒翻一遍上百个
   * 记录文件（opencode 那一支更是要起子进程）纯属白费。
   */
  useEffect(() => {
    if (!providerKey || !open) return;
    const pull = () => {
      pollRef.current = true;
      setNonce((n) => n + 1);
    };
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") pull();
    }, POLL_MS);
    window.addEventListener("focus", pull);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", pull);
    };
  }, [providerKey, open]);

  const openPicker = (target: HTMLElement) => {
    const rect = target.getBoundingClientRect();
    // 触发按钮横跨整条侧边栏，锚左边缘更自然（工作区行的菜单锚右边缘，是因为
    // 那边的触发按钮贴着右侧）；再夹住视口，别跑到屏幕外
    setPicker({
      x: Math.min(Math.max(8, rect.left), window.innerWidth - CLI_MENU_W - 8),
      y: rect.bottom,
    });
  };

  /**
   * 拖动面板上边缘改高度。走指针捕获而不是监听 window：
   * 指针移出这条 1px 的细线后照样收得到事件。
   */
  const onHandleDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // 收起时列表不在，拖了也看不出变化
    if (!open) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { startY: event.clientY, startHeight: height };
    setDragging(true);
    document.body.classList.add("codedock-dragging-row");
  };

  const onHandleMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    // 上限还要看侧边栏本身有多高，否则能把上面的工作区列表挤没
    const room = (rootRef.current?.parentElement?.clientHeight ?? 0) - RESERVED_ABOVE;
    const limit = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, room));
    // 面板贴底，往上拖是变高，位移取反
    const next = drag.startHeight - (event.clientY - drag.startY);
    setHeight(Math.min(limit, Math.max(MIN_HEIGHT, next)));
  };

  const onHandleUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
    setDragging(false);
    document.body.classList.remove("codedock-dragging-row");
    try {
      // 用 state 里最新的值：拖动过程中它一直在变
      window.sessionStorage.setItem(HEIGHT_KEY, String(height));
    } catch {
      // 记不住就下次还是默认高度
    }
  };

  /** 列表区显示什么。优先级从高到低，只有一个能命中 */
  const body = () => {
    if (!provider) {
      // 只有命令写成包名（`npx -y @anthropic-ai/claude-code`）这类认不出的情况
      // 才走到这儿，提示一下支持哪几家
      return (
        <p className={HINT}>
          认不出「{current?.name || value}」是哪家 CLI，读不到它的会话历史。目前支持
          {CLI_PROVIDERS.map((item) => item.label).join(" / ")}
        </p>
      );
    }
    if (error) {
      return <p className="px-2 py-1 text-[11px] text-danger">读取会话失败：{error}</p>;
    }
    if (loading && items.length === 0) {
      return <p className={HINT}>正在读取会话…</p>;
    }
    if (items.length === 0) {
      return (
        <p className={HINT}>
          这个目录还没有 {provider.label} 的会话
        </p>
      );
    }
    return (
      <ul className="flex flex-col">
        {items.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              onClick={() =>
                onResume(resumeCommand(value, item.id, provider), item.title || "未命名会话")
              }
              title={`${item.title || "未命名会话"}\n${item.id}`}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] text-fg-muted hover:bg-hover hover:text-fg"
            >
              <span className="min-w-0 flex-1 truncate">
                {item.title || "未命名会话"}
              </span>
              <span className="shrink-0 text-[11px] text-fg-faint">
                {formatTime(item.updated)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    );
  };

  return (
    <div ref={rootRef} className="flex shrink-0 flex-col">
      {/* 上边缘兼作拖动条：面板贴在侧边栏底部，往上拖就是变高。
          原来的 border-t 由这条 1px 的线接手，和编辑器分栏用同一套样式 */}
      <div
        role="separator"
        aria-orientation="horizontal"
        onPointerDown={onHandleDown}
        onPointerMove={onHandleMove}
        onPointerUp={onHandleUp}
        onPointerCancel={onHandleUp}
        title={open ? "拖动调整会话历史的高度" : undefined}
        className={`relative h-px shrink-0 bg-line-strong transition-colors ${
          dragging ? "bg-accent-strong" : open ? "cursor-row-resize hover:bg-line-hover" : ""
        }`}
      >
        {/* 加宽命中区，视觉上仍是一条细线 */}
        <span className="absolute inset-x-0 -top-1 -bottom-1" />
      </div>

      {/* 分组标题，样式照抄侧栏的「工作区」标题：让人一眼看出这块是会话历史，
          而不是又一排工具按钮。收起按钮靠标题右缘——它管的就是下面这一整块，
          跟标题同排比跟选择器挤一行更顺。折叠时标题和按钮都常显 */}
      <div className="flex h-7 shrink-0 items-center gap-1 pr-2 pl-4">
        <span className="text-[11px] font-medium tracking-wide text-fg-faint">
          对话历史
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => setOpen((on) => !on)}
          title={open ? "收起会话历史" : "展开会话历史"}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-faint hover:bg-active hover:text-fg"
        >
          {open ? (
            <IconChevronDown className="h-3.5 w-3.5" />
          ) : (
            <IconChevronRight className="h-3.5 w-3.5" />
          )}
        </button>
      </div>

      {/* 折叠时连这一整行一起收起，只留上面的标题 + 箭头：收起来就该是一条干净的分组头。
          刷新按钮已去掉——列表本来就每 20 秒自动拉一次，窗口切回来也会拉，手动那颗纯属多余 */}
      {open && (
        <div className="flex h-8 shrink-0 items-center gap-1 px-2">
          <button
            type="button"
            onClick={(event) => openPicker(event.currentTarget)}
            disabled={commands.length === 0}
            title="选择要查看哪家的会话历史"
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px] text-fg-muted hover:bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <AgentLogo name={current?.name ?? ""} command={value} className="h-3.5 w-3.5" />
            <span className="min-w-0 flex-1 truncate">
              {current?.name || provider?.label || value}
            </span>
            <IconChevronDown className="h-3 w-3 shrink-0 text-fg-faint" />
          </button>
        </div>
      )}

      {/* 自己管住高度：侧边栏根是 flex-col、上面的工作区列表是 flex-1，
          这里不封顶的话条目一多就把工作区列表挤没了。高度可拖（见上边缘的拖动条） */}
      {open && (
        <div className="min-h-0 shrink-0 overflow-auto px-2 pb-2" style={{ height }}>
          {body()}
        </div>
      )}

      {/* 选择器菜单。fixed 定位 + 遮罩接外部点击，和侧边栏其余菜单同一套 */}
      {picker && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setPicker(null)} />
          <div
            className="fixed z-40 flex flex-col rounded border border-line-strong bg-raised py-1 shadow-lg"
            style={{
              width: CLI_MENU_W,
              left: picker.x,
              // 条数不定，按实际行数折算高度，免得贴底时被顶出可视区
              top: Math.min(
                picker.y + 4,
                window.innerHeight - (commands.length * 26 + 20),
              ),
            }}
          >
            {commands.map((item, index) => (
              <button
                key={`${item.name}-${item.command}-${index}`}
                type="button"
                onClick={() => {
                  setPicker(null);
                  onChange(item.command);
                }}
                title={item.name || "未命名 AI CLI"}
                className={CLI_MENU_ITEM}
              >
                <AgentLogo name={item.name} command={item.command} />
                <span className="truncate">{item.name || "未命名 AI CLI"}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
