import { useEffect, useRef, useState } from "react";
import { readOfficeBytes, type OfficeKind } from "../lib/office";

interface OfficePreviewProps {
  path: string;
  kind: OfficeKind;
}

type Phase = { kind: "loading" } | { kind: "ready" } | { kind: "error"; message: string };

/**
 * Word 在同一个 run 里可以同时指定西文和东亚字体。浏览器的 font-family
 * fallback 只按“哪个字体有这个 glyph”选择；如果西文字体也带 CJK glyph，
 * 就会把本该用东亚字体的汉字提前吃掉。把文本按 script 拆成小 span，才能
 * 强制对应字符走 DOCX 的 ascii / eastAsia 字体变量。
 */
const EAST_ASIAN_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/u;

function splitDocxTextByScript(value: string): Array<{ text: string; eastAsian: boolean }> {
  const parts: Array<{ text: string; eastAsian: boolean }> = [];
  let current = "";
  let currentEastAsian: boolean | null = null;

  for (const char of value) {
    const eastAsian = EAST_ASIAN_CHAR.test(char);
    if (currentEastAsian !== null && eastAsian !== currentEastAsian) {
      parts.push({ text: current, eastAsian: currentEastAsian });
      current = "";
    }
    current += char;
    currentEastAsian = eastAsian;
  }
  if (current) parts.push({ text: current, eastAsian: currentEastAsian ?? false });
  return parts;
}

/** 将 docx-preview 生成的混排文本固定到 DOCX 对应的两套字体级联。 */
function applyDocxScriptFonts(host: HTMLElement) {
  const spans = Array.from(host.querySelectorAll<HTMLElement>(".codovo-docx span"));
  for (const span of spans) {
    // 符号 run 自己带有 font-family，不能被普通文字的 script 字体覆盖。
    if (span.style.fontFamily) continue;
    const styles = getComputedStyle(span);
    const asciiFont = styles.getPropertyValue("--docx-font-ascii").trim();
    const eastAsianFont = styles.getPropertyValue("--docx-font-ea").trim();
    if (!asciiFont || !eastAsianFont || asciiFont === eastAsianFont) continue;

    for (const node of Array.from(span.childNodes)) {
      if (node.nodeType !== Node.TEXT_NODE || !node.nodeValue) continue;
      const parts = splitDocxTextByScript(node.nodeValue);
      const fragment = document.createDocumentFragment();
      for (const part of parts) {
        const child = document.createElement("span");
        child.style.fontFamily = part.eastAsian ? "var(--docx-font-ea)" : "var(--docx-font-ascii)";
        child.textContent = part.text;
        fragment.appendChild(child);
      }
      span.replaceChild(fragment, node);
    }
  }
}

/**
 * Word / Excel / PowerPoint 的只读预览。三种文档各自用一套纯前端渲染库，
 * 都按需动态加载——不打开 Office 文档就不会为它们付出体积。
 *
 * 文档本身不进 Monaco、没有 model，和 PDF / 图片一样属于「打开即预览」；
 * 应用里也不提供编辑，所以切走再切回来重新解析一遍即可。
 */
export function OfficePreview({ path, kind }: OfficePreviewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let cancelled = false;
    let cleanup: (() => void) | null = null;
    let resizeTimer: number | undefined;
    host.innerHTML = "";
    setPhase({ kind: "loading" });

    void (async () => {
      const buffer = await readOfficeBytes(path);
      if (cancelled) return;

      if (kind === "docx") {
        const { renderAsync } = await import("@apollo-design/docx-preview");
        if (cancelled) return;
        // body 与 style 都落在同一个容器上：样式跟着组件卸载一起消失，不会污染全局
        await renderAsync(buffer, host, host, {
          className: "codovo-docx",
          inWrapper: true,
          breakPages: true,
          renderHeaders: true,
          renderFooters: true,
          // 内嵌字体转成 data URL，避免 WebView2 的 blob 字体在本地文档预览中
          // 因 CSP / 生命周期限制失效，导致中文回退到浏览器默认字体。
          useBase64URL: true,
        });
        if (cancelled) return;
        applyDocxScriptFonts(host);
        // 内嵌字体是异步解码的，必须等字体 ready 后再测量页面宽度和应用 zoom，
        // 否则先按 fallback 字体测量会造成混排文本换行与 WPS 不一致。
        await document.fonts.ready;
        if (cancelled) return;

        // A4 页面固定 816px 左右，窄面板里会横着被截断。按容器宽度等比缩放
        // （CSS zoom 会一起收滚动高度，不像 transform 那样留下空白）。
        // 面板够宽时不缩放，保持文档原始尺寸
        const wrapper = host.querySelector<HTMLElement>(".codovo-docx-wrapper");
        const page = host.querySelector<HTMLElement>("section.codovo-docx");
        if (wrapper && page) {
          // wrapper 左右各 30px 内边距。用 offsetWidth 取原始宽度：getBoundingClientRect
          // 会被 zoom 一起缩放，重复测量会越算越宽
          const naturalWidth = page.offsetWidth + 60;
          const fit = () => {
            const width = host.clientWidth;
            // 面板收起来时宽度是 0，算出来是负数。等 ResizeObserver 报出真实宽度再缩放
            if (width < 40) return;
            const zoom = Math.min(1, (width - 8) / naturalWidth);
            wrapper.style.zoom = zoom < 0.999 ? zoom.toFixed(4) : "";
          };
          fit();
          const observer = new ResizeObserver(() => {
            window.clearTimeout(resizeTimer);
            resizeTimer = window.setTimeout(fit, 120);
          });
          observer.observe(host);
          cleanup = () => observer.disconnect();
        }
      } else if (kind === "xlsx") {
        const [{ default: jsPreviewExcel }] = await Promise.all([
          import("@js-preview/excel"),
          import("@js-preview/excel/lib/index.css"),
        ]);
        if (cancelled) return;
        const previewer = jsPreviewExcel.init(host, { showContextmenu: false });
        cleanup = () => previewer.destroy();
        await previewer.preview(buffer);
      } else {
        const { init } = await import("pptx-preview");
        if (cancelled) return;

        // 幻灯片按容器尺寸缩放；窗口 / 分栏变了要重新挂载一次预览器，
        // 旧的先摘掉再建，避免两份内容叠在一起
        let previewer: ReturnType<typeof init> | null = null;
        const mount = (width: number, height: number) => {
          previewer?.destroy();
          host.innerHTML = "";
          previewer = init(host, { width, height, mode: "list" });
          return previewer.preview(buffer);
        };
        const size = () => ({
          width: Math.max(320, host.clientWidth),
          height: Math.max(240, host.clientHeight),
        });
        let current = size();
        await mount(current.width, current.height);
        if (cancelled) return;

        const observer = new ResizeObserver(() => {
          // 拖动分栏时尺寸每秒变很多次，停手后再重排一次
          window.clearTimeout(resizeTimer);
          resizeTimer = window.setTimeout(() => {
            if (cancelled) return;
            const next = size();
            if (next.width === current.width && next.height === current.height) return;
            current = next;
            void mount(next.width, next.height).catch(() => {
              // 重排失败不影响已经渲染出来的内容
            });
          }, 250);
        });
        observer.observe(host);
        cleanup = () => {
          observer.disconnect();
          previewer?.destroy();
        };
      }

      if (!cancelled) setPhase({ kind: "ready" });
    })().catch((reason: unknown) => {
      if (cancelled) return;
      setPhase({ kind: "error", message: reason instanceof Error ? reason.message : String(reason) });
    });

    return () => {
      cancelled = true;
      window.clearTimeout(resizeTimer);
      cleanup?.();
      host.innerHTML = "";
    };
  }, [path, kind]);

  return (
    <div className="absolute inset-0 overflow-hidden bg-surface">
      <div
        ref={hostRef}
        className={`h-full w-full ${kind === "docx" ? "office-docx overflow-auto" : "overflow-hidden"}`}
      />
      {phase.kind !== "ready" && (
        <div className="absolute inset-0 flex items-center justify-center bg-surface px-6 text-center">
          {phase.kind === "loading" ? (
            <p className="text-[12px] text-fg-faint">加载中…</p>
          ) : (
            <p className="text-[12px] text-warn">无法预览该文档：{phase.message}</p>
          )}
        </div>
      )}
    </div>
  );
}
