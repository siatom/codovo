import { useRef, type MouseEvent } from "react";
import { useMermaidBlocks } from "../lib/mermaid";

interface MarkdownPreviewProps {
  /** 已经渲染并清理过的 HTML */
  html: string;
}

/** 只读的 markdown 渲染结果；排版样式在 styles.css 的 .markdown-body 里 */
export function MarkdownPreview({ html }: MarkdownPreviewProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  // mermaid 只能异步出图，这里在渲染完成后补水合进预览层
  useMermaidBlocks(bodyRef, html);

  // WebView2 里点 <a> 会把整个应用界面导航成那个网页（回不来），所以全部拦掉。
  // 第一版不接系统浏览器（项目没装 opener 插件），链接暂时只是不能点。
  const blockLinks = (event: MouseEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest("a")) event.preventDefault();
  };

  return (
    <div
      ref={bodyRef}
      className="markdown-body absolute inset-0 overflow-auto"
      onClick={blockLinks}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
