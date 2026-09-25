import { useEffect, useState } from "react";
import { formatTime } from "../lib/agent";
import {
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
  IconRefresh,
} from "./icons";

interface CliHistoryProps {
  /** 当前工作区。只列落在这个目录里的会话 */
  cwd: string;
  /** settings.aiCommands 过滤后的列表 */
  commands: AiCommand[];
  /** 当前选中的命令行 */
  value: string;
  onChange: (command: string) => void;
  /** 点一条会话：参数是拼好的完整 resume 命令 */
  onResume: (command: string) => void;
}

/** 选择器菜单宽度（px）。比项目行的菜单宽：名字前面多一个 logo */
const CLI_MENU_W = 160;

const CLI_MENU_ITEM =
  "flex items-center gap-2 px-3 py-1 text-left text-[12px] text-fg-muted hover:bg-hover hover:text-fg";

const HINT = "px-2 py-1 text-[11px] text-fg-faint";

/**
 * 侧边栏底部的「当前 AI CLI 的会话历史」。
 *
 * 数据来自 CLI 自己写在磁盘上的会话记录（后端 cli_list_sessions），点一条就新开
 * 一个终端标签跑 resume。只在终端（TUI）模式下出现——GUI 那边项目行下面已经有
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
  /** 选择器菜单的位置，fixed 定位 */
  const [picker, setPicker] = useState<{ x: number; y: number } | null>(null);

  const current = commands.find((item) => item.command === value);
  const provider = cliProvider(value, current?.name ?? "");
  const providerKey = provider?.key ?? "";

  // 切项目 / 换 CLI / 展开 / 手动刷新都走这里。不做轮询：一次刷新要翻一百多个
  // 记录文件，而列表只在真的跑过或 resume 过 CLI 之后才变，那两种动作界面都知道
  useEffect(() => {
    // 折叠着就别去读盘了
    if (!providerKey || !open) {
      setItems([]);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    listCliSessions(providerKey, cwd)
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
        if (!cancelled) setLoading(false);
      });
    // 丢掉作废请求的迟到结果（换项目后旧的慢请求可能后回来）
    return () => {
      cancelled = true;
    };
  }, [cwd, providerKey, open, nonce]);

  const openPicker = (target: HTMLElement) => {
    const rect = target.getBoundingClientRect();
    // 触发按钮横跨整条侧边栏，锚左边缘更自然（项目行的菜单锚右边缘，是因为
    // 那边的触发按钮贴着右侧）；再夹住视口，别跑到屏幕外
    setPicker({
      x: Math.min(Math.max(8, rect.left), window.innerWidth - CLI_MENU_W - 8),
      y: rect.bottom,
    });
  };

  /** 列表区显示什么。优先级从高到低，只有一个能命中 */
  const body = () => {
    if (!provider) {
      return (
        <p className={HINT}>
          当前 CLI（{current?.name || value}）读不到会话历史，目前只支持 CodeBuddy 和
          Claude Code
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
              onClick={() => onResume(resumeCommand(value, item.id))}
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
    <div className="flex shrink-0 flex-col border-t border-line">
      <div className="flex h-8 shrink-0 items-center gap-1 px-2">
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

        <button
          type="button"
          onClick={() => setNonce((n) => n + 1)}
          disabled={loading || !provider}
          title="刷新会话列表"
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-faint hover:bg-active hover:text-fg disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <IconRefresh className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {/* 自己管住高度：侧边栏根是 flex-col、上面的项目列表是 flex-1，
          这里不封顶的话条目一多就把项目列表挤没了 */}
      {open && (
        <div className="max-h-56 min-h-0 shrink-0 overflow-auto px-2 pb-2">
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
