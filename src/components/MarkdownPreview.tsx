import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { highlightCodeFences, syncHighlightTheme } from "../lib/highlight";
import { pathsExist, pathsPresent, samePath } from "../lib/fs";
import { resolveLocalLink } from "../lib/markdown";
import { useMermaidBlocks } from "../lib/mermaid";
import { useTheme } from "../lib/theme";
import { IconList } from "./icons";

interface MarkdownPreviewProps {
  /** 已经渲染并清理过的 HTML */
  html: string;
  /** 超过 8MB 的文件不渲染正文，只显示降级提示 */
  isLarge?: boolean;
  /**
   * 是否显示右侧文档大纲。默认关：翻译视图等窄面板里再切一列会把正文挤没。
   * 没有标题时自动不显示。
   */
  outline?: boolean;
  /** 当前 markdown 文件的绝对路径，用来解析文档里的相对文件链接 */
  filePath?: string | null;
  /** 工作区根。本地链接只允许打开这些目录里的文件 */
  roots?: string[];
  /** 打开工作区里的文件；由上层决定直接开标签还是先转临时工作区 */
  onOpenPath?: (path: string) => void;
}

const HEADING_SELECTOR = "h1,h2,h3,h4,h5,h6";

interface OutlineItem {
  /** 渲染 HTML 里的标题 id；用户手写的原始 HTML 标题可能没有 */
  id: string;
  /** 1–6 */
  level: number;
  /** 已解码的纯文本，列表里长标题靠 CSS 截断 */
  text: string;
}

/**
 * 从渲染结果里取标题。
 * 用 DOMParser 而不是正则：标题里可能有 `<code>`、行内公式、图片，正则拆不干净；
 * 同时 HTML 实体也已经解码好，不用自己还原 `&amp;`。
 */
function readOutline(html: string): OutlineItem[] {
  if (!html) return [];
  const doc = new DOMParser().parseFromString(html, "text/html");
  return Array.from(doc.querySelectorAll<HTMLElement>(HEADING_SELECTOR)).map((heading) => {
    // KaTeX 同时输出 MathML 和视觉两套结构，textContent 会把公式读成两遍；
    // 丢掉 MathML 那半，标题里带公式时大纲才不会是「x2x2」
    heading.querySelectorAll(".katex-mathml").forEach((node) => node.remove());
    const text = (heading.textContent ?? "").replace(/\s+/g, " ").trim();
    return {
      id: heading.id,
      level: Number(heading.tagName.slice(1)),
      // 纯图片标题没有文字，退回 alt，至少能在列表里认出是哪一节
      text: text || heading.querySelector("img")?.getAttribute("alt")?.trim() || "",
    };
  });
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
export function MarkdownPreview({
  html,
  isLarge = false,
  outline = false,
  filePath = null,
  roots,
  onOpenPath,
}: MarkdownPreviewProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const outlineNavRef = useRef<HTMLElement>(null);
  const { palette, theme } = useTheme();
  const [highlighted, setHighlighted] = useState<{ key: string; html: string } | null>(null);
  /** 当前滚到正文里的第几个标题，用来在大纲里标出所在章节 */
  const [activeHeading, setActiveHeading] = useState(0);

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

  /**
   * 大纲按 marked 的原始 HTML 生成，不用高亮后的那份：高亮只改写代码块，
   * 标题结构不变，省得每次异步高亮完成都重算一遍。
   */
  const outlineItems = useMemo(
    () => (outline && !isLarge ? readOutline(html) : []),
    [html, isLarge, outline],
  );
  /** 文档可能从 h2 起头，缩进按最浅的一级算，不浪费左侧宽度 */
  const outlineMinLevel = useMemo(
    () => outlineItems.reduce((min, item) => Math.min(min, item.level), 6),
    [outlineItems],
  );
  const showOutline = outline && outlineItems.length > 0;

  /** 滚动时把当前章节标出来；rAF 合并同一帧里的多次 scroll */
  useEffect(() => {
    const container = bodyRef.current;
    if (!showOutline || !container) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const headings = container.querySelectorAll<HTMLElement>(HEADING_SELECTOR);
      if (headings.length === 0) return;
      // 判定线放在视口上方四分之一处：章节标题滚进这一段就算「正在读」，
      // 比贴着容器上沿更符合阅读直觉，也能吸收对照模式同步滚动带来的几十像素偏差
      const viewTop =
        container.getBoundingClientRect().top + Math.min(240, container.clientHeight * 0.25);
      let current = 0;
      for (let i = 0; i < headings.length; i += 1) {
        if (headings[i].getBoundingClientRect().top <= viewTop) current = i;
        else break;
      }
      // 滚到底时最后一节可能永远到不了判定线，直接把它标成当前章节
      if (container.scrollTop + container.clientHeight >= container.scrollHeight - 4) {
        current = headings.length - 1;
      }
      setActiveHeading(current);
    };
    const schedule = () => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(update);
    };
    update();
    container.addEventListener("scroll", schedule, { passive: true });
    // 图片 / 公式加载后标题位置会变，跟着重算
    container.addEventListener("load", schedule, true);
    const observer = new ResizeObserver(schedule);
    observer.observe(container);
    return () => {
      container.removeEventListener("scroll", schedule);
      container.removeEventListener("load", schedule, true);
      observer.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [showOutline, outlineItems, renderedHtml]);

  // 长文档里当前章节可能早就滚出大纲面板的可视区，跟着把那一行带进来
  useEffect(() => {
    const nav = outlineNavRef.current;
    const item = nav?.children[activeHeading];
    if (!nav || !(item instanceof HTMLElement)) return;
    if (item.offsetTop < nav.scrollTop) {
      nav.scrollTop = item.offsetTop;
    } else if (item.offsetTop + item.offsetHeight > nav.scrollTop + nav.clientHeight) {
      nav.scrollTop = item.offsetTop + item.offsetHeight - nav.clientHeight;
    }
  }, [activeHeading]);

  /** 大纲按文档顺序取第几个标题去滚，不走 id：原始 HTML 标题不一定有 id */
  const handleOutlineClick = useCallback((index: number) => {
    const container = bodyRef.current;
    if (!container) return;
    const target = container.querySelectorAll<HTMLElement>(HEADING_SELECTOR)[index];
    if (!target) return;
    setActiveHeading(index);
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  // WebView2 里点 <a> 会把整个应用界面导航成那个网页（回不来），所以所有链接都先拦掉，
  // 再按类型分流：页内锚点滚动、外链交给系统浏览器、本地文件按工作区边界解析后打开。
  const handleLinkClick = (event: MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as Element | null)?.closest("a");
    if (!(anchor instanceof HTMLAnchorElement)) return;
    event.preventDefault();

    // `data-md-href` 是净化前存下的原始地址：file: 链接的 href 会被 DOMPurify 删掉
    const href = (
      anchor.getAttribute("data-md-href") ??
      anchor.getAttribute("href") ??
      ""
    ).trim();
    if (!href) return;
    if (href.startsWith("#")) {
      scrollToAnchor(bodyRef.current, href.slice(1));
      return;
    }
    if (/^(https?:|ftp:|mailto:)/i.test(href)) {
      // 打不开就算了：阅读预览时弹一个错误提示反而打扰
      void openUrl(href).catch(() => {});
      return;
    }
    if (!filePath || !roots || roots.length === 0 || !onOpenPath) return;

    const targets = resolveLocalLink(href, filePath, roots);
    if (targets.length === 0) return;

    // 同一篇文档里的 `./self.md#section`：标签已经开着，直接滚到锚点即可
    const self = targets.find((target) => samePath(target.path, filePath));
    if (self) {
      if (self.fragment) scrollToAnchor(bodyRef.current, self.fragment);
      return;
    }

    void (async () => {
      const paths = targets.map((target) => target.path);
      try {
        const [present, directories] = await Promise.all([
          pathsPresent(paths),
          pathsExist(paths),
        ]);
        const index = present.findIndex(Boolean);
        if (index < 0) return;
        if (directories[index]) {
          // 目录链接交给系统文件管理器；应用内没有「只开目录」的标签类型
          await openPath(targets[index].path);
          return;
        }
        onOpenPath(targets[index].path);
      } catch {
        // 检查 / 打开失败按「链接不可用」处理，不打断阅读
      }
    })();
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
    <div className="absolute inset-0 flex min-h-0 bg-surface">
      <div
        ref={bodyRef}
        className="markdown-body min-w-0 flex-1 overflow-auto"
        onClick={handleLinkClick}
        onAuxClick={blockAuxClick}
        dangerouslySetInnerHTML={{ __html: renderedHtml }}
      />
      {showOutline && (
        <aside
          aria-label="文档大纲"
          // 宽度跟容器走：分屏时正文可能只有几百像素，固定 220 会把两边都挤扁
          style={{ width: "clamp(148px, 22%, 220px)" }}
          className="flex h-full shrink-0 flex-col border-l border-line bg-content"
        >
          <div className="flex shrink-0 items-center gap-1.5 px-3 pt-3 pb-1.5 text-[11px] font-medium text-fg-dim">
            <IconList className="h-3.5 w-3.5 text-fg-icon" />
            大纲
          </div>
          <nav ref={outlineNavRef} className="min-h-0 flex-1 overflow-auto px-1.5 pb-3">
            {outlineItems.map((item, index) => {
              const indent = Math.min(3, Math.max(0, item.level - outlineMinLevel));
              const active = index === activeHeading;
              return (
                <button
                  key={`${item.id || "heading"}:${index}`}
                  type="button"
                  onClick={() => handleOutlineClick(index)}
                  aria-current={active ? "location" : undefined}
                  title={item.text || "未命名标题"}
                  style={{ paddingLeft: `${8 + indent * 12}px` }}
                  className={`mt-0.5 flex w-full items-center rounded py-1 pr-2 text-left text-[12px] leading-snug transition-colors ${
                    active ? "bg-selected text-fg" : "text-fg-dim hover:bg-hover hover:text-fg"
                  }`}
                >
                  <span className="truncate">{item.text || "未命名标题"}</span>
                </button>
              );
            })}
          </nav>
        </aside>
      )}
    </div>
  );
}
