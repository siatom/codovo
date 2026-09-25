import { useEffect } from "react";
import { renderMarkdown } from "../lib/markdown";
import { IconClose, IconSparkle } from "./icons";

interface ExplainChangeDialogProps {
  /** 标题里显示的文件名（工作区相对路径） */
  title: string;
  /** 解读正文（markdown）；null = 还在等大模型 */
  text: string | null;
  error: string | null;
  onClose: () => void;
}

/** 标题栏那个关闭按钮，和 ExplorerPane 头部图标按钮同一套观感 */
const CLOSE_BUTTON =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-dim hover:bg-active hover:text-fg";

/**
 * AI 改动解读的结果弹窗。外壳照 ConfirmDialog 那一套（遮罩 + 圆角卡片），
 * 点遮罩或按 Esc 都关掉。
 *
 * 正文自己渲染而不是用 MarkdownPreview：那个组件是 `absolute inset-0` 的整屏预览层，
 * 脱了文档流就撑不起卡片高度（弹窗会塌得只剩标题栏）。这里照智能体气泡的做法，
 * 用 `markdown-body agent-text` 在流内渲染（去掉预览那套底色和内边距），
 * 卡片自然长高、到 70vh 封顶后由外层滚动。
 */
export function ExplainChangeDialog({
  title,
  text,
  error,
  onClose,
}: ExplainChangeDialogProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      onClick={onClose}
    >
      {/* 高度封顶后正文自己滚动：解读可能有好几段，别把弹窗撑出屏幕 */}
      <div
        role="dialog"
        aria-modal="true"
        className="flex max-h-[70vh] w-[560px] max-w-full flex-col overflow-hidden rounded-xl border border-line-strong bg-raised shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex h-9 shrink-0 items-center gap-1.5 border-b border-line px-3">
          <IconSparkle className="h-3.5 w-3.5 shrink-0 text-accent-soft" />
          <span className="min-w-0 flex-1 truncate text-[12px] text-fg-muted" title={title}>
            变更解读 · {title}
          </span>
          <button type="button" onClick={onClose} title="关闭" className={CLOSE_BUTTON}>
            <IconClose className="h-3 w-3" />
          </button>
        </header>

        {error ? (
          <p className="shrink-0 px-4 py-3 text-[12px] whitespace-pre-wrap text-danger">{error}</p>
        ) : text === null ? (
          <p className="flex shrink-0 items-center gap-1.5 px-4 py-3 text-[12px] text-fg-faint">
            <IconSparkle className="h-3.5 w-3.5 animate-pulse" />
            正在解读这个文件的改动…
          </p>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
            <div
              className="markdown-body agent-text"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
