import { useEffect, useMemo, useState } from "react";

import { renderMarkdown } from "./markdown";
import { monaco, monacoThemeFor } from "./monaco-setup";
import { useTheme, type ResolvedTheme, type Theme } from "./theme";

/**
 * 智能体回答与工具输出的代码高亮。
 *
 * 不另引高亮库：Monaco 本来就在产物里（编辑器用的就是它），语言定义、tokenizer 和主题里
 * 那套 `.mtk*` 配色全是现成的。复用它，代码块的颜色跟编辑器里看到的完全一致，也省得再
 * 维护一份「语言名 → 高亮器」的映射表。
 *
 * 代价是异步：Monaco 的语言包是懒加载的（registerLanguage 里挂着 loader），第一次取 token
 * 之前必须等它 resolve，所以这里只提供 Promise 接口。调用方拿不到结果时先按纯文本渲染，
 * 拿到了再换成高亮版本。
 */

/** fence 上写的语言名 → Monaco 语言 id。模型写什么的都有，先归一化再交给 Monaco。 */
const LANGUAGE_ALIASES: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  shellscript: "shell",
  console: "shell",
  py: "python",
  python3: "python",
  yml: "yaml",
  rs: "rust",
  golang: "go",
  "c++": "cpp",
  "c#": "csharp",
  htm: "html",
  ps1: "powershell",
  pwsh: "powershell",
};

/** 一次高亮最多处理多少字符。读个大文件再整段 tokenize 会把主线程顶住，收益也不值这个价 */
const MAX_CODE_LENGTH = 20_000;

/**
 * 把语言名解析成 Monaco 认得的语言 id；认不出返回 null（调用方按纯文本渲染）。
 * 空串和 `plaintext` / `text` / `txt` 这种「本来就没有语法」的写法也一并归一成 null。
 */
export function resolveLanguage(name: string | null | undefined): string | null {
  const key = name?.trim().toLowerCase() ?? "";
  if (!key || key === "plaintext" || key === "text" || key === "txt") return null;
  const id = LANGUAGE_ALIASES[key] ?? key;
  return monaco.languages.getLanguages().some((item) => item.id === id) ? id : null;
}

/**
 * Monaco 的主题是全局的，转换函数跟编辑器共用，这样 `.mtk*` 配色和编辑器对得上。
 * 预览层自己调 colorize 前也要先把主题同步过去，否则拿到的是上一次的主题配色。
 */
export function syncHighlightTheme(palette: Theme, theme: ResolvedTheme) {
  // 同一个主题名 Monaco 自己会短路，重复调用没有代价
  monaco.editor.setTheme(monacoThemeFor(palette, theme));
}

/**
 * Monaco 的 colorize 是给「行」用的：每行包一层 span、行尾补 `<br/>`，空格全换成不换行空格。
 * 塞进 `<pre>` 之前得处理一下——不换行空格换回普通空格（pre 本来就保留空白，而 nbsp 复制
 * 出去会把代码弄坏），末尾那个行尾 `<br/>` 也要去掉，否则代码块底下会多出一行空行。
 */
function normalize(html: string): string {
  return html.replace(/\u00a0/g, " ").replace(/<br\/>$/, "");
}

/**
 * 高亮一段代码，返回可以直接塞进 `<pre>` 的 HTML；内容为空、太长、语言阅读器加载失败时
 * 返回 null。文本由 Monaco 自己转义，不是把原文往 DOM 里塞。
 */
export async function highlightCode(code: string, languageId: string): Promise<string | null> {
  if (!code.trim() || code.length > MAX_CODE_LENGTH) return null;
  try {
    return normalize(await monaco.editor.colorize(code, languageId, {}));
  } catch {
    // 语言包加载失败（理论上不该发生）：退回纯文本，总比整块不显示强
    return null;
  }
}

/**
 * marked 渲染出的围栏代码块：`<pre><code class="language-xxx">…</code></pre>`。
 * 对照预览会给 `<pre>` 补 `data-src-line`，所以开始标签要允许带属性，
 * 替换时也要原样保留，否则高亮后行号锚点就丢了。
 */
const FENCED_CODE = /<pre([^>]*)><code class="language-([^"]*)">([\s\S]*?)<\/code><\/pre>/g;

/** marked 只会转义 `&<>"'` 这几个字符（见它的 escape 表），照着还原即可 */
function unescapeHtml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * 把 markdown 渲染结果里的围栏代码块逐个换成高亮版本，其余部分原样返回。
 * 语言认不出或高亮失败时保留 marked 原来那一段（它已经把代码转义好了）。
 *
 * 顺序上：`renderMarkdown` 里已经过了一遍 DOMPurify，这里补进去的只有 Monaco 生成的
 * `<span class="mtkN">` 和它转义过的文本，不会绕过净化。
 */
export async function highlightCodeFences(html: string): Promise<string> {
  const jobs: { start: number; end: number; html: Promise<string> }[] = [];
  for (const match of html.matchAll(FENCED_CODE)) {
    const start = match.index ?? 0;
    const language = resolveLanguage(match[2]);
    // marked 会在代码末尾补一个换行，留着它会多渲染出一行空行
    const code = unescapeHtml(match[3]).replace(/\n$/, "");
    jobs.push({
      start,
      end: start + match[0].length,
      html: language
        ? highlightCode(code, language).then((inner) =>
            inner === null ? match[0] : `<pre${match[1]}>${inner}</pre>`,
          )
        : Promise.resolve(match[0]),
    });
  }
  if (jobs.length === 0) return html;

  const pieces = await Promise.all(jobs.map((job) => job.html));
  let out = "";
  let cursor = 0;
  jobs.forEach((job, index) => {
    out += html.slice(cursor, job.start) + pieces[index];
    cursor = job.end;
  });
  return out + html.slice(cursor);
}

/**
 * 一段代码的高亮结果。返回 null 表示「还没算出来」（或者语言认不出），调用方先按纯文本渲染。
 */
export function useHighlightedCode(code: string, languageId: string | null): string | null {
  const { palette, theme } = useTheme();
  const [done, setDone] = useState<{ key: string; html: string } | null>(null);
  // 主题也算 key 的一段：切浅色后 Monaco 的 token 颜色编号会变，得重新高亮才对得上色
  const key = `${palette}:${theme}\n${languageId ?? ""}\n${code}`;

  useEffect(() => {
    if (!languageId) return;
    let alive = true;
    syncHighlightTheme(palette, theme);
    void highlightCode(code, languageId).then((html) => {
      if (alive && html !== null) setDone({ key, html });
    });
    return () => {
      alive = false;
    };
    // key 已经涵盖了下面用到的每一个值，变了才需要重算
  }, [key, languageId, code, palette, theme]);

  return done && done.key === key ? done.html : null;
}

/**
 * 智能体回答的 markdown：先渲染普通版本（代码块还没有色），高亮算好之后整体替换。
 * `enabled` 传 false（流式输出途中）就完全不跑 markdown。
 */
export function useHighlightedMarkdown(text: string, enabled = true): string {
  const { palette, theme } = useTheme();
  const base = useMemo(() => (enabled ? renderMarkdown(text) : ""), [enabled, text]);
  const [done, setDone] = useState<{ base: string; html: string } | null>(null);

  useEffect(() => {
    if (!base) return;
    let alive = true;
    syncHighlightTheme(palette, theme);
    void highlightCodeFences(base).then((html) => {
      // html 与 base 相同时（没有代码块，或者全都认不出语言）不必再触发一次渲染
      if (alive && html !== base) setDone({ base, html });
    });
    return () => {
      alive = false;
    };
  }, [base, palette, theme]);

  return done && done.base === base ? done.html : base;
}
