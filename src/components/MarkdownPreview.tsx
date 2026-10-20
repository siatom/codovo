import { useEffect, useRef, useState, type MouseEvent } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { highlightCodeFences, syncHighlightTheme } from "../lib/highlight";
import { useMermaidBlocks } from "../lib/mermaid";
import { useTheme } from "../lib/theme";

interface MarkdownPreviewProps {
  /** 已经渲染并清理过的 HTML */
  html: string;
  /** 超过 8MB 的文件不渲染正文，只显示降级提示 */
  isLarge?: boolean;
}

/** 解码锚点；编码损坏时退回原文，避免一次点击抛异常 */
function decodeFragment(fragment: string): string {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

/** 在预览容器内找标题锚点；找不到再退回整篇文档，兼容原始 HTML 里的 id */
function scrollToAnchor(container: HTMLElement | null, fragment: string): void {
  const id = decodeFragment(fragment);
  if (!id) return;
  const scoped = container
    ? Array.from(container.querySelectorAll<HTMLElement>("[id]")).find((el) => el.id === id)
    : undefined;
  const target = scoped ?? document.getElementById(id);
  target?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** 只读的 markdown 渲染结果；排版样式在 styles.css 的 .markdown-body 里 */
export function MarkdownPreview({ html, isLarge = false }: MarkdownPreviewProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const { palette, theme } = useTheme();
  const [highlighted, setHighlighted] = useState<{ key: string; html: string } | null>(null);

  /**
   * Monaco 的 colorize 是异步的，先用 marked 的原始 HTML 顶上，算完再整体替换。
   * 主题参与 key：切浅色后 token 颜色编号会变，必须重新高亮才能和编辑器配色一致。
   */
  const highlightKey = `${palette}:${theme}\n${html}`;
  useEffect(() => {
    if (isLarge || !html) return;
    let alive = true;
    syncHighlightTheme(palette, theme);
    void highlightCodeFences(html)
      .then((next) => {
        if (alive && next !== html) setHighlighted({ key: highlightKey, html: next });
      })
      .catch(() => {
        // 高亮失败保留 marked 原始 <pre><code>，不阻断预览
      });
    return () => {
      alive = false;
    };
  }, [highlightKey, html, isLarge, palette, theme]);

  const renderedHtml = highlighted?.key === highlightKey ? highlighted.html : html;
  // mermaid 只能异步出图，这里在渲染完成后补水合进预览层。
  // 传高亮后的 HTML：代码高亮完成时会替换 innerHTML，已经注入的 SVG 需要重新补一遍。
  useMermaidBlocks(bodyRef, renderedHtml);

  // WebView2 里点 <a> 会把整个应用界面导航成那个网页（回不来），所以所有链接都先拦掉，
  // 再按类型分流：页内锚点滚动、外链交给系统浏览器、相对路径暂不处理。
  const handleLinkClick = (event: MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as Element | null)?.closest("a");
    if (!(anchor instanceof HTMLAnchorElement)) return;
    event.preventDefault();

    const href = (anchor.getAttribute("href") ?? "").trim();
    if (!href) return;
    if (href.startsWith("#")) {
      scrollToAnchor(bodyRef.current, href.slice(1));
      return;
    }
    if (/^(https?:|mailto:)/i.test(href)) {
      // 打不开就算了：阅读预览时弹一个错误提示反而打扰
      void openUrl(href).catch(() => {});
      return;
    }
    // 相对路径 / file: 等本地链接不交给 WebView 导航；暂时没有「打开文件」入口，明确忽略
  };

  const blockAuxClick = (event: MouseEvent<HTMLDivElement>) => {
    // 中键也会让 WebView 导航，同样拦掉
    if (event.button === 1 && (event.target as Element).closest("a")) event.preventDefault();
  };

  if (isLarge) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-surface px-6 text-center">
        <p className="text-[13px] text-warn">大文件已关闭 Markdown 预览</p>
        <p className="text-[12px] text-fg-faint">文件超过 8 MB，为保持编辑流畅，预览不再渲染。</p>
        <p className="text-[12px] text-fg-faint">切回编辑模式可查看与修改源文本。</p>
      </div>
    );
  }

  return (
    <div
      ref={bodyRef}
      className="markdown-body absolute inset-0 overflow-auto"
      onClick={handleLinkClick}
      onAuxClick={blockAuxClick}
      dangerouslySetInnerHTML={{ __html: renderedHtml }}
    />
  );
}
