import { useEffect, useMemo, useRef } from "react";
import { renderMarkdown } from "../lib/markdown";
import { useMermaidBlocks } from "../lib/mermaid";
import { IconClose, IconSparkle } from "./icons";

interface ExplainChangeDialogProps {
  /** 标题里显示的文件名（工作区相对路径） */
  title: string;
  /** 解读正文（markdown）；null = 还在等大模型 */
  text: string | null;
  error: string | null;
  onClose: () => void;
  /** 标题前缀。默认「变更解读」；解读整个文件时传「文件解读」 */
  titlePrefix?: string;
  /** 等待大模型时的提示。默认按「解读改动」写 */
  loadingText?: string;
}

/** 标题栏那个关闭按钮，和 ExplorerPane 头部图标按钮同一套观感 */
const CLOSE_BUTTON =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-dim hover:bg-active hover:text-fg";

/**
 * AI 解读（改动解读 / 文件解读）的结果弹窗。外壳照 ConfirmDialog 那一套
 * （遮罩 + 圆角卡片），点遮罩或按 Esc 都关掉。
 *
 * 正文自己渲染而不是用 MarkdownPreview：那个组件是 `absolute inset-0` 的整屏预览层，
 * 脱了文档流就撑不起卡片高度（弹窗会塌得只剩标题栏）。这里用 `markdown-body dialog-text`
 * 在流内渲染（去掉预览那套底色和内边距，留白交给卡片的 px/py），
 * 卡片自然长高、到 78vh 封顶后由外层滚动。
 *
 * 宽度给 640：解读正文多是列表 + 行内代码，窄了会频繁折行；再宽又不好扫行。
 */
export function ExplainChangeDialog({
  title,
  text,
  error,
  onClose,
  titlePrefix = "变更解读",
  loadingText = "正在解读这个文件的改动…",
}: ExplainChangeDialogProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const bodyRef = useRef<HTMLDivElement>(null);
  const html = useMemo(() => (text === null ? "" : renderMarkdown(text)), [text]);
  // 解读正文里也可能带 mermaid 流程图，和编辑器预览走同一套异步水合
  useMermaidBlocks(bodyRef, html);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      // 认「按下点就在遮罩上」而不是 click：从弹窗内按下、拖到遮罩上松开会误判成点外部
      onMouseDown={(event) => {
        if (event.button === 0 && event.target === event.currentTarget) onClose();
      }}
    >
      {/* 高度封顶后正文自己滚动：解读可能有好几段，别把弹窗撑出屏幕 */}
      <div
        role="dialog"
        aria-modal="true"
        className="flex max-h-[78vh] w-[640px] max-w-full flex-col overflow-hidden rounded-xl border border-line-strong bg-raised shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        {/* 标题栏分三层：火花 + 前缀（弱）· 文件名（强）。文件名才是这一眼要看的东西 */}
        <header className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-4">
          <IconSparkle className="h-4 w-4 shrink-0 text-accent-soft" />
          <span className="shrink-0 text-[12px] text-fg-dim">{titlePrefix}</span>
          <span className="shrink-0 text-[12px] text-fg-faint">·</span>
          <span className="min-w-0 flex-1 truncate text-[13px] text-fg" title={title}>
            {title}
          </span>
          <button type="button" onClick={onClose} title="关闭" className={CLOSE_BUTTON}>
            <IconClose className="h-3.5 w-3.5" />
          </button>
        </header>

        {error ? (
          /* 失败也给足留白：错误行常常是厂商原文，多行要看得清 */
          <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
            <p className="rounded-md border border-danger-line bg-danger-bg px-3 py-2 text-[12px] whitespace-pre-wrap text-danger">
              {error}
            </p>
          </div>
        ) : text === null ? (
          <p className="flex shrink-0 items-center gap-2 px-4 py-3 text-[12px] text-fg-faint">
            <IconSparkle className="h-3.5 w-3.5 animate-pulse text-accent-soft" />
            {loadingText}
          </p>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
            <div
              ref={bodyRef}
              className="markdown-body dialog-text"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
