import { useEffect, type RefObject } from "react";
import { useTheme, type ResolvedTheme } from "./theme";

/**
 * Mermaid 流程图：按需加载 + 预览层水合。
 *
 * mermaid 体积不小，静态 import 会把它算进首屏产物；这里第一次遇到流程图时才动态载入，
 * Vite 会把它拆成独立 chunk。渲染结果按「主题 + 字体 + 源码」缓存——对照预览每敲一下
 * 都会重渲染整篇 markdown，但只要图没改，就不用重新排版。
 */

type MermaidApi = typeof import("mermaid").default;

/** 缓存条数上限。一屏文档里的图远少于这个数，超出时只丢最早的一条 */
const MAX_CACHE = 60;

let loading: Promise<MermaidApi> | null = null;
let sequence = 0;
/** 注入到 DOM 的实例编号：同一段源码可能同时出现在多张图里，不能共用同一个 SVG id */
let instance = 0;
/** mermaid.initialize 是全局配置，和 render 一起串行执行，避免两个预览用不同主题时互相覆盖 */
let queue: Promise<unknown> = Promise.resolve();
interface RenderedSvg {
  svg: string;
  /** mermaid 生成时用的 id；复用缓存时要换成当前实例的 id */
  id: string;
}
const cache = new Map<string, Promise<RenderedSvg>>();

function loadMermaid(): Promise<MermaidApi> {
  loading ??= import("mermaid").then((module) => module.default);
  return loading;
}

/** 取界面当前字体，让图里的文字和正文保持一致（mermaid 会把字体写进 SVG） */
function uiFontFamily(): string {
  return getComputedStyle(document.body).fontFamily || "sans-serif";
}

/**
 * 渲染一张 mermaid 图，返回可直接塞进 DOM 的 SVG。
 * 失败不写缓存：改好语法后再调用会重新渲染。
 */
export function renderMermaid(source: string, theme: ResolvedTheme): Promise<string> {
  const fontFamily = uiFontFamily();
  const key = `${theme}\u0000${fontFamily}\u0000${source}`;
  let cached = cache.get(key);
  if (!cached) {
    const task = queue.then(async () => {
      const mermaid = await loadMermaid();
      mermaid.initialize({
        startOnLoad: false,
        // strict 会转义标签里的 HTML，并禁掉 click 回调 / javascript: 链接
        securityLevel: "strict",
        // 出错由预览层自己提示，别让 mermaid 再往页面里塞一张错误图
        suppressErrorRendering: true,
        theme: theme === "dark" ? "dark" : "default",
        fontFamily,
      });
      const id = `codedock-mermaid-${(sequence += 1)}`;
      const { svg } = await mermaid.render(id, source);
      return { svg, id };
    });
    // 前一次失败也不能把后面的渲染卡死
    queue = task.catch(() => undefined);

    cache.set(key, task);
    void task.catch(() => cache.delete(key));
    if (cache.size > MAX_CACHE) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cached = task;
  }

  // 缓存里是同一段 SVG，直接复用会出现重复的顶层 id / marker 引用；
  // 每次注入换一个实例 id，保证 DOM 里的 id 唯一。
  return cached.then(({ svg, id }) => {
    const unique = `codedock-mermaid-view-${(instance += 1)}`;
    return svg.split(id).join(unique);
  });
}

/**
 * 把容器里还没出图的 `.md-mermaid` 逐个渲染出来。
 *
 * 源码一直留在 `.md-mermaid-src` 里：出图后 CSS 把它藏起来，语法错误时再露出来当兜底。
 * html 变化（编辑 / 重新渲染）或主题切换都会重跑，上一轮还没回来的结果靠 cancelled 丢掉。
 */
export function useMermaidBlocks(
  rootRef: RefObject<HTMLElement | null>,
  html: string,
): void {
  const { theme } = useTheme();

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const blocks = Array.from(root.querySelectorAll<HTMLElement>(".md-mermaid"));
    if (blocks.length === 0) return;

    let cancelled = false;
    for (const block of blocks) {
      const source = block.querySelector(".md-mermaid-src")?.textContent ?? "";
      if (!source.trim()) continue;

      // 主题切换会重跑这个 effect：先清掉上一轮注入的图和错误提示，源码本身一直在
      block.querySelector(".md-mermaid-svg")?.remove();
      block.querySelector(".md-mermaid-error")?.remove();
      block.dataset.state = "loading";

      void renderMermaid(source, theme).then(
        (svg) => {
          if (cancelled || !block.isConnected) return;
          const holder = document.createElement("div");
          holder.className = "md-mermaid-svg";
          holder.innerHTML = svg;
          block.prepend(holder);
          block.dataset.state = "ready";
        },
        (error: unknown) => {
          if (cancelled || !block.isConnected) return;
          const note = document.createElement("div");
          note.className = "md-mermaid-error";
          note.textContent = `流程图渲染失败：${
            error instanceof Error ? error.message : String(error)
          }`;
          block.prepend(note);
          block.dataset.state = "error";
        },
      );
    }

    return () => {
      cancelled = true;
    };
  }, [rootRef, html, theme]);
}
