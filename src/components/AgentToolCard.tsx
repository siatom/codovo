import { useState } from "react";
import type { AgentPart, AgentToolStatus } from "../lib/types";
import {
  IconChevronDown,
  IconChevronRight,
  IconFile,
  IconGlobe,
  IconSearch,
  IconSparkle,
  IconTerminal,
} from "./icons";

type ToolPart = Extract<AgentPart, { type: "tool" }>;

/** 按工具名挑个图标。认不出的给通用的四角星，别让卡片没图标。 */
function iconFor(tool: string) {
  switch (tool) {
    case "read":
    case "write":
    case "edit":
    case "patch":
      return IconFile;
    case "bash":
    case "shell":
      return IconTerminal;
    case "grep":
    case "glob":
    case "list":
      return IconSearch;
    case "webfetch":
    case "websearch":
      return IconGlobe;
    default:
      return IconSparkle;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/** 从入参里抠一句能当标题的话。不同工具的关键字段名不一样，挨个试。 */
function summarize(input: unknown): string {
  const record = asRecord(input);
  if (!record) return "";
  for (const key of ["filePath", "command", "pattern", "path", "query", "url"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

const STATUS_TEXT: Record<AgentToolStatus, string> = {
  pending: "待执行",
  running: "进行中…",
  completed: "完成",
  error: "失败",
};

/**
 * 一次工具调用的卡片：一行摘要 + 可展开的输出。
 *
 * 第一版不渲染 edit/write 的改动内容，只看路径和状态——diff 预览留到后面单独做。
 */
export function AgentToolCard({ part }: { part: ToolPart }) {
  const [open, setOpen] = useState(false);
  const { state, tool } = part;
  const Icon = iconFor(tool);

  const title = state.title?.trim() || summarize(state.input) || tool;
  const detail = state.status === "error" ? state.error : state.output;
  const failed = state.status === "error";

  return (
    <div
      className={`my-1.5 overflow-hidden rounded-xl border ${
        failed ? "border-danger-line bg-danger-bg" : "border-line bg-raised"
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={!detail}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left enabled:hover:bg-hover disabled:cursor-default"
      >
        {detail ? (
          open ? (
            <IconChevronDown className="h-3 w-3 shrink-0 text-fg-faint" />
          ) : (
            <IconChevronRight className="h-3 w-3 shrink-0 text-fg-faint" />
          )
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <Icon className={`h-3.5 w-3.5 shrink-0 ${failed ? "text-danger" : "text-fg-dim"}`} />
        <span className="shrink-0 font-mono text-[11px] text-fg-muted">{tool}</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-fg-dim">{title}</span>
        {/* 状态做成小圆片，一眼能从标题行里挑出来 */}
        <span
          className={`shrink-0 rounded-full bg-active px-1.5 text-[10px] leading-4 ${
            failed
              ? "text-danger"
              : state.status === "completed"
                ? "text-fg-faint"
                : "text-accent-soft"
          }`}
        >
          {STATUS_TEXT[state.status]}
        </span>
      </button>

      {open && detail && (
        <pre className="max-h-60 overflow-auto border-t border-line bg-app px-2.5 py-2 font-mono text-[11px] leading-relaxed text-fg-muted">
          {detail}
        </pre>
      )}
    </div>
  );
}
