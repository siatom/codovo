import { useState } from "react";
import { resolveLanguage, useHighlightedCode } from "../lib/highlight";
import { languageOf } from "../lib/languages";
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

/** 工具输出那一块的观感，高亮与纯文本两条路共用，免得改样式时漏掉一条 */
const OUTPUT_CLASS =
  "max-h-60 overflow-auto border-t border-line bg-app px-2.5 py-2 font-mono text-[11px] leading-relaxed text-fg-muted";

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
  for (const key of ["filePath", "command", "pattern", "path", "query", "url", "sql", "table"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/**
 * 猜工具输出是什么语言，供高亮用；猜不出就返回 null（按纯文本渲染）。
 * 读 / 写 / 改文件类工具的输出就是文件内容，语言取入参里的路径；
 * bash 的输出严格说不是 shell 源码，但命令类输出里认得出来的多半也只是注释和路径，
 * 按 shell 上色比整块灰着更容易扫。
 */
function outputLanguage(tool: string, input: unknown): string | null {
  if (tool === "bash" || tool === "shell") return "shell";
  if (tool === "read" || tool === "write" || tool === "edit" || tool === "patch") {
    const record = asRecord(input);
    const path = record?.filePath ?? record?.path;
    if (typeof path !== "string") return null;
    return resolveLanguage(languageOf(path));
  }
  return null;
}

const STATUS_TEXT: Record<AgentToolStatus, string> = {
  pending: "待执行",
  running: "进行中…",
  completed: "完成",
  error: "失败",
};

/** 一次查询的结果表。数据库 Agent 的 run_query 工具会把结果以 `{columns, rows}` 回传。 */
interface GridData {
  columns: string[];
  rows: (string | null)[][];
  hasMore: boolean;
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * 把工具输出解析成结果表。工具有时会在 JSON 前后缀点说明文字，所以先整段试，
 * 失败再从第一个 `{` 到最后一个 `}` 截一段试。形状对不上就返回 null（按普通文本展示）。
 */
function parseGrid(output: string | undefined): GridData | null {
  if (!output) return null;
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  const candidates = [output, start >= 0 && end > start ? output.slice(start, end + 1) : ""];
  for (const text of candidates) {
    if (!text) continue;
    const parsed = parseJson(text);
    if (!parsed) continue;
    const columns = parsed.columns;
    const rows = parsed.rows;
    if (!Array.isArray(columns) || !Array.isArray(rows)) continue;
    if (!columns.every((column) => typeof column === "string")) continue;
    if (!rows.every((row) => Array.isArray(row))) continue;
    return {
      columns: columns as string[],
      rows: rows as (string | null)[][],
      hasMore: parsed.hasMore === true,
    };
  }
  return null;
}

/** 结果表：列头固定、单元格截断，最多这一块自己滚，不把整条对话撑长 */
function ResultGrid({ data }: { data: GridData }) {
  return (
    <div className="max-h-72 overflow-auto border-t border-line bg-app">
      <table className="min-w-full border-collapse font-mono text-[11px]">
        <thead>
          <tr>
            {data.columns.map((name, index) => (
              <th
                key={index}
                className="sticky top-0 z-10 border-b border-line bg-raised px-2 py-1 text-left font-medium whitespace-nowrap text-fg-muted"
              >
                {name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="hover:bg-hover">
              {row.map((cell, cellIndex) => (
                <td
                  key={cellIndex}
                  title={cell ?? "NULL"}
                  className="max-w-[240px] truncate border-b border-line px-2 py-0.5 whitespace-nowrap text-fg-dim"
                >
                  {cell === null ? <span className="text-fg-faint italic">NULL</span> : cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {data.rows.length === 0 && (
        <div className="px-2 py-1 text-[11px] text-fg-faint">没有返回任何行</div>
      )}
      {data.hasMore && (
        <div className="px-2 py-1 text-[11px] text-fg-faint">结果已截断，只显示前若干行</div>
      )}
    </div>
  );
}

/**
 * 展开后的工具输出。语言认出来就上高亮，`language` 传 null（或高亮还没算好）时按纯文本渲染。
 */
function ToolOutput({ text, language }: { text: string; language: string | null }) {
  const html = useHighlightedCode(text, language);
  if (html === null) return <pre className={OUTPUT_CLASS}>{text}</pre>;
  return <pre className={OUTPUT_CLASS} dangerouslySetInnerHTML={{ __html: html }} />;
}

/**
 * 一次工具调用的卡片：一行摘要 + 可展开的输出。
 *
 * 数据库 Agent 的查询结果（`{columns, rows}`）会**直接铺成表格**、默认可见，
 * 不需要再点开；其余工具仍按一行摘要 + 展开文本渲染。
 */
export function AgentToolCard({ part }: { part: ToolPart }) {
  const [open, setOpen] = useState(false);
  const { state, tool } = part;
  const Icon = iconFor(tool);

  const title = state.title?.trim() || summarize(state.input) || tool;
  const detail = state.status === "error" ? state.error : state.output;
  const failed = state.status === "error";
  // 错误输出不解析成表格（那多半是报错文本，不是结果集）；同理也不按文件语言上色
  const grid = failed ? null : parseGrid(state.output);
  const language = failed ? null : outputLanguage(tool, state.input);
  const canExpand = !grid && Boolean(detail);

  return (
    <div
      className={`my-1.5 overflow-hidden rounded-xl border ${
        failed ? "border-danger-line bg-danger-bg" : "border-line bg-raised"
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={!canExpand}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left enabled:hover:bg-hover disabled:cursor-default"
      >
        {canExpand ? (
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

      {grid && <ResultGrid data={grid} />}

      {!grid && open && detail && <ToolOutput text={detail} language={language} />}
    </div>
  );
}
