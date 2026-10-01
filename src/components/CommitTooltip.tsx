import { useLayoutEffect, useRef, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { CommitStat, GitCommit } from "../lib/types";
import { IconCommit, IconCopy, IconPerson } from "./icons";

/** 浮框宽度。够放下一行完整的提交正文，又不至于盖掉半个窗口 */
const WIDTH = 380;
/** 与提交行之间留的间距 */
const GAP = 10;
/** 贴到窗口边缘时至少留的白 */
const EDGE = 8;

/** 绝对时间，形如「2026年10月1日 22:05」 */
function absoluteTime(seconds: number): string {
  const date = new Date(seconds * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/**
 * 把提交正文拆成要显示的几行。
 *
 * 整段都用 `- ` / `* ` 起头的才当列表渲染（把记号换成圆点，照 VS Code 的样子）；
 * 只要有一行不是，就当普通段落原样保留换行——硬折行的段落按列表渲染会散架。
 */
function bodyLines(body: string): { text: string; bullet: boolean }[] {
  const lines = body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return [];
  const listed = lines.every((line) => /^[-*•]\s+/.test(line));
  return lines.map((line) => ({
    text: listed ? line.replace(/^[-*•]\s+/, "") : line,
    bullet: listed,
  }));
}

/**
 * 提交行的悬停浮框：署名、时间、主题、正文要点、改动规模、提交号。
 *
 * 定位用 `fixed`：提交列表在 `overflow-auto` 里，绝对定位会被裁掉；这里靠
 * 「祖先里没有 transform」这条前提（和 ConfirmDialog 一样）让它相对视口摆。
 * 右栏本身就贴着窗口右边，所以优先摆在提交行**左侧**。
 */
export function CommitTooltip({
  commit,
  relative,
  stat,
  anchor,
}: {
  commit: GitCommit;
  /** 「41 分钟前」这种相对时间，和提交行上用同一个 */
  relative: string;
  /** null = 还没拉到 */
  stat: CommitStat | null;
  /** 提交行的视口坐标，浮框贴着它摆 */
  anchor: DOMRect;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  const left = Math.max(EDGE, anchor.left - GAP - WIDTH);

  // 高度要等渲染出来才知道，所以在 paint 之前量一次再把纵向位置夹回窗口内，
  // 免得贴着屏幕上下边缘的提交行把浮框顶出去。
  // **夹完还得盯着**：改动规模是异步拉回来的，拉回来之后浮框会长高，只按 anchor 夹一次的话
  // 新长出来的那截就掉到窗口外面去了。ResizeObserver 一发现尺寸变了就重新夹。
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const place = () => {
      const maxTop = window.innerHeight - EDGE - element.offsetHeight;
      element.style.top = `${Math.min(Math.max(EDGE, anchor.top), Math.max(EDGE, maxTop))}px`;
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(element);
    return () => observer.disconnect();
  }, [anchor]);

  const copy = () => {
    void writeText(commit.hash).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };

  const lines = bodyLines(commit.body);

  return (
    <div
      ref={ref}
      className="fixed z-50 flex flex-col rounded border border-line-strong bg-raised px-2.5 py-2 text-[11px] shadow-lg"
      style={{ width: WIDTH, left, top: anchor.top }}
    >
      <div className="flex items-center gap-1.5 text-fg-faint">
        <IconPerson className="h-3.5 w-3.5" />
        <span className="text-accent">{commit.author}</span>
        <IconCommit className="ml-1 h-3.5 w-3.5" />
        <span>
          {relative}（{absoluteTime(commit.time)}）
        </span>
      </div>

      <p className="mt-2 text-[12px] font-semibold text-fg-bright">{commit.subject}</p>

      {lines.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1">
          {lines.map((line, index) => (
            <li key={index} className="flex gap-1.5 text-fg-muted">
              {line.bullet && <span className="text-fg-faint">•</span>}
              <span className="min-w-0">{line.text}</span>
            </li>
          ))}
        </ul>
      )}

      {/* 合并提交按 git show 的口径是空 diff，这时不摆这一行，免得写成「0 个文件」 */}
      {stat && stat.files > 0 && (
        <p className="mt-2 text-fg-faint">
          已更改 {stat.files} 个文件，
          {/* +绿 / -红，和「变更」列表里的 diff 统计同一套色，一眼能看出是加还是删 */}
          <span className="text-ok">{stat.insertions} 行插入(+)</span>，
          <span className="text-danger">{stat.deletions} 行删除(-)</span>
        </p>
      )}

      <div className="mt-2 flex items-center gap-1.5">
        <IconCommit className="h-3.5 w-3.5 text-fg-faint" />
        {/* 编号本身就当按钮：旁边那颗复制小图标才 12px，扫过去很难瞄准 */}
        <button
          type="button"
          onClick={copy}
          title={copied ? "已复制" : `复制完整提交号 ${commit.hash}`}
          className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-active"
        >
          <span className="font-mono text-accent">{commit.short}</span>
          {copied ? (
            <span className="text-fg-faint">已复制</span>
          ) : (
            <IconCopy className="h-3 w-3 text-fg-faint" />
          )}
        </button>
      </div>
    </div>
  );
}
