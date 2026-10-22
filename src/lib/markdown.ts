import DOMPurify, { type UponSanitizeAttributeHookEvent } from "dompurify";
import {
  Marked,
  Renderer,
  type RendererThis,
  type Token,
  type Tokens,
} from "marked";
import markedKatex from "marked-katex-extension";
import { assetUrl } from "./asset-url";
import { isPathInside, ownerRoot, pathKey } from "./fs";

/** mermaid 代码块的 fence 语言名（`mmd` 是常见简写） */
const MERMAID_LANGS = new Set(["mermaid", "mmd"]);

/**
 * mermaid 代码块先落成占位块，真正的出图交给预览层的异步 effect。
 * 渲染正文必须是同步的，而 mermaid.render 是 Promise；源码留在 <pre> 里当兜底，
 * 出图后由 MarkdownPreview 把它藏起来，语法错误时又能原样看到。
 */
function mermaidBlock({ text, lang }: Tokens.Code): string | null {
  const name = (lang ?? "").trim().split(/\s+/)[0]?.toLowerCase();
  if (!name || !MERMAID_LANGS.has(name)) return null;
  return `<div class="md-mermaid" data-state="pending"><pre class="md-mermaid-src">${esc(text)}</pre></div>`;
}

/**
 * 预览用的 markdown 渲染器。
 * async 必须显式关掉：异步模式下 parse 返回 Promise，这里要的是同步拿字符串。
 * gfm 本来就是默认值，写出来是为了说明表格、任务列表、删除线都支持。
 *
 * 数学公式走 KaTeX。`nonStandard` 让 `$x^2$` 这种不加空格的写法也能认出来——
 * 技术文档里几乎没人会在公式两侧刻意留空格；代价是 `$5` 这类金额偶尔会被当成公式，
 * 但 `throwOnError: false` 会把它原样留下来，不至于把整篇预览搞崩。
 */
const md = new Marked({
  async: false,
  gfm: true,
  renderer: {
    code(token) {
      return mermaidBlock(token) ?? false;
    },
  },
});

/**
 * 行号锚点要覆盖 KaTeX 的块级公式：它走 marked 的扩展渲染器，不经过 SourceLineRenderer。
 * 这里包一层扩展渲染器，从本次渲染的活动行号表里取公式块自己的起始行。
 * 渲染是同步的，activeSourceLines 不会在两个 parse 之间交错；普通预览时它是 null，等于不处理。
 */
let activeSourceLines: SourceLineMap | null = null;
const katexExtension = markedKatex({ throwOnError: false, nonStandard: true });
md.use({
  ...katexExtension,
  extensions: katexExtension.extensions?.map((extension) => {
    const render = "renderer" in extension ? extension.renderer : null;
    if (!render) return extension;
    return {
      ...extension,
      renderer(this: RendererThis, token: Tokens.Generic) {
        const html = render.call(this, token);
        // 扩展渲染器允许返回 false / undefined 表示「交回默认渲染」，只处理真正的 HTML
        return typeof html === "string"
          ? withLine(html, activeSourceLines?.get(token))
          : html;
      },
    };
  }),
});

/**
 * 正文的净化规则。markdown 里允许写 HTML，但内容可能来自 clone 下来的仓库，
 * 不能把脚本能力一起放进来：
 * - 保留常规 HTML / SVG / MathML（KaTeX 会同时输出 MathML 与 HTML 两套结构）；
 * - 禁掉 `<style>`、`<iframe>`、`<object>`、`<embed>`、`<form>` 这类能加载外部资源
 *   或提交数据的容器；任务列表的 `<input type="checkbox">` 是 marked 生成的，保留；
 * - `style` 属性要留着：KaTeX 的排版全靠行内样式，删了公式就会散架。
 */
const SANITIZE_OPTIONS = {
  USE_PROFILES: { html: true, svg: true, mathMl: true },
  FORBID_TAGS: ["style", "script", "iframe", "object", "embed", "form", "link", "meta", "base"],
};

/**
 * 相对图片路径的解析规则。
 *
 * markdown 里的 `![](./x.png)` 原样交给 WebView 会以应用自身的源为基准去找，必然 404。
 * 这里按 markdown 文件所在目录补全，再换成 asset 协议地址；和 html / svg 预览共用同一套
 * `assetUrl`（工作区根在工作区打开时已经加进 asset 白名单）。
 *
 * 只放行工作区里的文件：`../../etc/passwd` 这类越界路径不解析，留成坏图，
 * 不能让预览变成读任意本地文件的入口。
 */
function normalizePath(path: string): string {
  const unified = path.replace(/\\/g, "/");
  const drive = /^[a-zA-Z]:/.exec(unified)?.[0] ?? "";
  const rest = unified.slice(drive.length);
  const absolute = rest.startsWith("/");
  const parts: string[] = [];
  for (const part of rest.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      // 已经到根就停在根上，别把 ../ 拼进最终路径
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `${drive}${absolute ? "/" : ""}${parts.join("/")}`;
}

function resolveImageSource(src: string, filePath: string, roots: string[]): string | null {
  const raw = src.trim();
  // 空地址、页面内锚点、协议相对地址都不该按本地文件处理
  if (!raw || raw.startsWith("#") || raw.startsWith("//")) return null;
  // `data:` / `http(s):` 这类地址原样交给 WebView；Windows 盘符不是协议，单独放行
  const windowsAbsolute = /^[a-zA-Z]:[\\/]/.test(raw);
  if (!windowsAbsolute && /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return null;
  // UNC 路径不在工作区沙箱的语义里，直接当坏图
  if (/^[\\/]{2}/.test(raw)) return null;

  // 查询串 / 锚点不属于路径；文件名里真有 `#` 的情况只能靠 URL 编码，这里不额外兼容
  const clean = raw.replace(/[?#].*$/, "");
  let decoded = clean;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    // 非法百分号编码：按原样用，别让整篇预览跟着抛错
  }

  const base = filePath.replace(/\\/g, "/").replace(/\/[^/]*$/, "");
  const full =
    windowsAbsolute || decoded.startsWith("/")
      ? normalizePath(decoded)
      : normalizePath(`${base}/${decoded}`);

  if (!roots.some((root) => isPathInside(full, root))) return null;
  return assetUrl(full);
}

/**
 * 本地文件链接的解析结果。`fragment` 是链接里的 `#...`，同文件跳转时用它滚到锚点。
 */
export interface MarkdownLinkTarget {
  /** 已归一化的绝对路径；调用方还需校验文件是否存在 */
  path: string;
  fragment: string;
}

/** 拆掉链接里的查询串与锚点。文件名里真有 `#` / `?` 只能靠 URL 编码，这里不额外兼容 */
function splitLinkSuffix(raw: string): { path: string; fragment: string } {
  const hash = raw.indexOf("#");
  const fragment = hash >= 0 ? raw.slice(hash + 1) : "";
  const withoutHash = hash >= 0 ? raw.slice(0, hash) : raw;
  const query = withoutHash.indexOf("?");
  return { path: query >= 0 ? withoutHash.slice(0, query) : withoutHash, fragment };
}

/**
 * 把 markdown 里的本地链接解析成工作区内的候选绝对路径。
 *
 * 支持相对路径（按 markdown 文件所在目录补全）、Windows 盘符路径和 `file:` URL。
 * 前导 `/` 按 VS Code 的习惯优先理解成「工作区根相对」，同时保留文件系统绝对路径
 * 作为候选：调用方按顺序做存在性检查，两种写法都能命中。
 *
 * 和相对图片一样只返回工作区根内的路径，越界的一律丢掉——预览不能变成读任意
 * 本地文件的入口。协议地址（http / mailto 等）不在这里处理，由预览层交给系统。
 */
export function resolveLocalLink(
  href: string,
  filePath: string,
  roots: string[],
): MarkdownLinkTarget[] {
  const raw = href.trim();
  if (!raw || raw.startsWith("#")) return [];
  // UNC 路径不在工作区沙箱的语义里
  if (/^[\\/]{2}/.test(raw)) return [];

  let decoded: string;
  let fragment: string;
  let candidates: string[];
  if (/^file:/i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return [];
    }
    // file://server/share 是远程 / UNC 路径，不解析
    if (url.hostname && url.hostname.toLowerCase() !== "localhost") return [];
    let pathname = url.pathname;
    try {
      pathname = decodeURIComponent(pathname);
    } catch {
      // 非法百分号编码：按原样用
    }
    // Windows 上 file:///D:/x 的 pathname 是 /D:/x，去掉盘符前多出来的斜杠
    if (/^\/[a-zA-Z]:[\\/]/.test(pathname)) pathname = pathname.slice(1);
    decoded = pathname;
    if (!decoded) return [];
    fragment = url.hash.startsWith("#") ? url.hash.slice(1) : "";
    candidates = [normalizePath(decoded)];
  } else {
    // Windows 盘符不是协议；其他带协议的地址不按本地文件处理
    const windowsAbsolute = /^[a-zA-Z]:[\\/]/.test(raw);
    if (!windowsAbsolute && /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return [];
    const split = splitLinkSuffix(raw);
    fragment = split.fragment;
    try {
      decoded = decodeURIComponent(split.path);
    } catch {
      decoded = split.path;
    }
    if (!decoded) return [];

    const base = filePath.replace(/\\/g, "/").replace(/\/[^/]*$/, "");
    if (!windowsAbsolute && decoded.startsWith("/")) {
      // 先按当前文件所属的根解析，再试其他根，最后退回文件系统绝对路径
      const owner = ownerRoot(roots, filePath);
      const ordered = owner
        ? [owner, ...roots.filter((root) => root !== owner)]
        : roots;
      candidates = [
        ...ordered.map((root) => normalizePath(`${root}/${decoded.replace(/^\/+/, "")}`)),
        normalizePath(decoded),
      ];
    } else if (windowsAbsolute) {
      candidates = [normalizePath(decoded)];
    } else {
      candidates = [normalizePath(`${base}/${decoded}`)];
    }
  }

  const targets: MarkdownLinkTarget[] = [];
  const seen = new Set<string>();
  for (const path of candidates) {
    const key = pathKey(path);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!roots.some((root) => isPathInside(path, root))) continue;
    targets.push({ path, fragment });
  }
  return targets;
}

/**
 * `resolveImage` 有值时才挂 hook。asset 协议在 macOS / Linux 是 `asset://`，
 * 不在 DOMPurify 默认的协议白名单里，所以放在净化**之后**改写 src——
 * 白名单不会把它剥掉，而写进去的地址也只可能是上面按沙箱规则拼出来的。
 *
 * 链接统一把原始 href 另存到 `data-md-href`：`file:` 不在 DOMPurify 默认的协议
 * 白名单里，净化后 href 会被删掉，预览层就再也拿不到点击目标了。
 */
function sanitize(html: string, resolveImage?: (src: string) => string | null): string {
  const annotateLink = (
    node: Element,
    data: UponSanitizeAttributeHookEvent,
  ) => {
    if (data.attrName !== "href" || node.tagName !== "A" || !data.attrValue) return;
    // 危险协议本来就会被净化器删掉，不把原始值留在 data 属性里
    if (/^\s*(?:javascript|vbscript|data):/i.test(data.attrValue)) return;
    node.setAttribute("data-md-href", data.attrValue);
  };
  const rewriteImage = (node: Element) => {
    if (node.tagName !== "IMG") return;
    const src = node.getAttribute("src");
    if (!src) return;
    const resolved = resolveImage?.(src);
    if (resolved) node.setAttribute("src", resolved);
  };

  DOMPurify.addHook("uponSanitizeAttribute", annotateLink);
  if (resolveImage) DOMPurify.addHook("afterSanitizeAttributes", rewriteImage);
  try {
    return DOMPurify.sanitize(html, SANITIZE_OPTIONS);
  } finally {
    DOMPurify.removeHook("uponSanitizeAttribute");
    if (resolveImage) DOMPurify.removeHook("afterSanitizeAttributes");
  }
}

/** 顶层块 token -> 源码里的起始行号；只给 markdown 对照滚动同步用 */
type SourceLineMap = WeakMap<object, number>;

interface RenderOptions {
  /**
   * 给每个顶层块打上 `data-src-line`，供对照模式按内容块同步滚动。
   * 默认不开：智能体气泡、解读弹窗这些地方用不上，省一次 token 遍历。
   */
  sourceLines?: boolean;
  /**
   * 当前 markdown 文件的绝对路径。给了它才解析相对图片：
   * `![](./diagram.png)` 必须按文件所在目录补全，才能落到工作区里的真实文件上。
   */
  filePath?: string;
  /**
   * 工作区根。图片只允许从这些目录里读，越界的路径不解析。
   */
  roots?: string[];
}

function newlineCount(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) count += 1;
  }
  return count;
}

/**
 * 给顶层 token 标源码行号。marked 的 token 不带位置，但顶层 token 的 `raw`
 * 按顺序拼起来就是原文，所以从上一个 token 的结尾往后找 `raw`，顺便累计换行数。
 * 找不到（极少见的自定义 token）就不推进游标，宁可少一个锚点，也不把行号算飞。
 */
function annotateTokens(tokens: Token[], text: string, baseLine: number): SourceLineMap {
  const map: SourceLineMap = new WeakMap();
  let cursor = 0;
  let line = baseLine;
  for (const token of tokens) {
    const raw = typeof token.raw === "string" ? token.raw : "";
    if (raw) {
      const found = text.indexOf(raw, cursor);
      if (found > cursor) {
        line += newlineCount(text.slice(cursor, found));
        cursor = found;
      }
    }
    map.set(token, line);
    line += newlineCount(raw);
    cursor += raw.length;
  }
  return map;
}

/** 把 data-src-line 插进渲染出的第一个开始标签里，保留 Renderer 原有的结构 */
function withLine(html: string, line: number | undefined): string {
  if (!line) return html;
  const match = /^(\s*<[A-Za-z][^\s/>]*)/.exec(html);
  if (!match) return html;
  return `${html.slice(0, match[0].length)} data-src-line="${line}"${html.slice(match[0].length)}`;
}

/** heading token 的纯文本：strong / em / link / codespan 都往下钻，图片取 alt */
function plainText(tokens: Token[] | undefined): string {
  if (!tokens) return "";
  let out = "";
  for (const token of tokens) {
    const node = token as Token & { text?: string; tokens?: Token[] };
    if (node.tokens && node.tokens.length > 0) out += plainText(node.tokens);
    else if (typeof node.text === "string") out += node.text;
  }
  return out;
}

/**
 * 标题锚点。保留中文 / 日文等非 ASCII 字母与数字，空格换成连字符；
 * 规则跟 CodeLite 的 slugify 保持一致，同一篇文档在两边生成的锚点相同。
 */
function slugify(text: string): string {
  const slug = text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");
  // 纯符号标题（例如 `### ---`）也得有个能跳的 id
  return slug || "section";
}

/** 一次渲染内的标题 id 去重：重复标题依次追加 -1、-2… */
class HeadingSlugger {
  private readonly used = new Set<string>();

  slug(text: string): string {
    const base = slugify(text);
    let id = base;
    let suffix = 1;
    while (this.used.has(id)) id = `${base}-${suffix++}`;
    this.used.add(id);
    return id;
  }
}

/** 把 id 插进 heading 的开始标签，和 data-src-line 可以同时存在 */
function withHeadingId(html: string, id: string): string {
  const match = /^(\s*<h[1-6])(?=[\s>])/.exec(html);
  if (!match) return html;
  return `${html.slice(0, match[0].length)} id="${esc(id)}"${html.slice(match[0].length)}`;
}

/**
 * 预览用的 Renderer：标题生成稳定 id，对照预览再给顶层块补行号锚点。
 * 嵌套块（引用 / 列表里的段落）不在 lineMap 里，走父级锚点，避免锚点过密。
 * 每次渲染新建一个实例，标题去重表不会串到上一篇文档。
 */
class PreviewRenderer extends Renderer {
  private readonly lines: SourceLineMap | null;
  private readonly slugs = new HeadingSlugger();

  constructor(lines: SourceLineMap | null) {
    super();
    this.lines = lines;
  }

  private mark(token: object, html: string): string {
    return withLine(html, this.lines?.get(token));
  }

  heading(token: Tokens.Heading) {
    const html = withHeadingId(super.heading(token), this.slugs.slug(plainText(token.tokens)));
    return this.mark(token, html);
  }

  paragraph(token: Tokens.Paragraph) {
    return this.mark(token, super.paragraph(token));
  }

  blockquote(token: Tokens.Blockquote) {
    return this.mark(token, super.blockquote(token));
  }

  list(token: Tokens.List) {
    return this.mark(token, super.list(token));
  }

  table(token: Tokens.Table) {
    return this.mark(token, super.table(token));
  }

  code(token: Tokens.Code) {
    return this.mark(token, mermaidBlock(token) ?? super.code(token));
  }

  hr(token: Tokens.Hr) {
    return this.mark(token, super.hr(token));
  }

  html(token: Tokens.HTML | Tokens.Tag) {
    return this.mark(token, super.html(token));
  }
}

/** frontmatter 的开 / 闭分隔行：独占一行的 `---`（允许行尾空白） */
const FM_FENCE = /^---[ \t]*$/;
/** 顶层的 `key: value` 行（key 不含冒号和空白） */
const FM_KEY = /^([^:\s][^:]*?)\s*:\s*(.*)$/;
/** 一行的缩进宽度 */
function indentOf(line: string): number {
  const m = /^[ \t]*/.exec(line);
  return m ? m[0].length : 0;
}

/** 一个 frontmatter 条目：key 为空串表示根级 `- ` 列表项 */
interface FmNode {
  key: string;
  value: string | string[] | FmNode[];
}

/** 去掉标量外层引号，并还原转义。认不出就原样返回 */
function cleanScalar(raw: string): string {
  const s = raw.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\(["\\])/g, "$1");
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  return s;
}

/** 按顶层逗号拆行内列表 `[a, b, c]`，逗号落在引号里不算分隔 */
function splitInlineList(inner: string): string[] {
  const items: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (const ch of inner) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ",") {
      items.push(cleanScalar(cur));
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim() !== "") items.push(cleanScalar(cur));
  return items;
}

/** 折叠块标量：连续非空行拼成一段（空格连接），空行分段 */
function foldLines(lines: string[]): string {
  const parts: string[] = [];
  for (const line of lines) {
    parts.push(line.trim() === "" ? "\n" : line.trim());
  }
  return parts.join(" ").replace(/ ?\n ?/g, "\n").trim();
}

/**
 * 读一个「key:」后面缩进更深的块，可能是块状列表或嵌套 map。
 * 认不出就把原始块当文本值返回，绝不丢内容。
 */
function readIndentedBlock(
  lines: string[],
  start: number,
  parentIndent: number,
): { value: string | string[] | FmNode[]; next: number } {
  let i = start;
  while (i < lines.length && lines[i].trim() === "") i++;
  // key 后面啥也没有，或后续行并不更深 → 空值
  if (i >= lines.length || indentOf(lines[i]) <= parentIndent) {
    return { value: "", next: start };
  }
  const childIndent = indentOf(lines[i]);
  const block: string[] = [];
  let j = i;
  while (j < lines.length) {
    const line = lines[j];
    if (line.trim() === "") {
      block.push("");
      j++;
      continue;
    }
    if (indentOf(line) < childIndent) break;
    // 去掉子块共同缩进，这样递归解析时又是「顶层」
    block.push(line.slice(childIndent));
    j++;
  }
  while (block.length && block[block.length - 1].trim() === "") block.pop();
  if (block.length === 0) return { value: "", next: j };

  if (/^-[ \t]/.test(block[0])) {
    // 块状列表：每个 `- ` 起一项，更深的续行并进上一项
    const items: string[] = [];
    let cur: string | null = null;
    for (const line of block) {
      if (/^-[ \t]/.test(line)) {
        if (cur !== null) items.push(cur.trim());
        cur = line.replace(/^-[ \t]?/, "");
      } else {
        cur = cur === null ? line.trim() : `${cur} ${line.trim()}`;
      }
    }
    if (cur !== null) items.push(cur.trim());
    return { value: items, next: j };
  }
  if (FM_KEY.test(block[0])) {
    // 嵌套 map：递归解析；万一解析不出来也退化成文本，不抛异常
    const nested = parseYamlBlock(block);
    return { value: nested ?? block.join("\n"), next: j };
  }
  return { value: block.join("\n"), next: j };
}

/**
 * 手写的小 YAML 解析器，只覆盖 frontmatter 常见写法。
 * 认不出的结构一律退化成文本值，返回 null 表示整块没有任何可识别条目。
 */
function parseYamlBlock(lines: string[]): FmNode[] | null {
  const nodes: FmNode[] = [];
  let i = 0;
  let recognized = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }
    // 顶层出现不该有的缩进行（没被上一个 key 吃掉）→ 整体放弃，交给普通 markdown
    if (indentOf(line) > 0) return null;

    if (/^-[ \t]/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^-[ \t]/.test(lines[i]) && indentOf(lines[i]) === 0) {
        items.push(cleanScalar(lines[i].replace(/^-[ \t]?/, "")));
        i++;
      }
      nodes.push({ key: "", value: items });
      recognized++;
      continue;
    }

    const m = FM_KEY.exec(line);
    if (!m) return null;
    const key = cleanScalar(m[1]);
    const rest = m[2].trim();
    i++;

    if (rest === "") {
      const { value, next } = readIndentedBlock(lines, i, 0);
      i = next;
      nodes.push({ key, value });
      recognized++;
      continue;
    }

    // 块标量 `>` / `>-` / `|` / `|-`（chomping 指示符对展示无影响，忽略）
    if (/^[>|][+-]?\s*$/.test(rest)) {
      const folded = rest[0] === ">";
      const deeper = 1;
      const collected: string[] = [];
      while (i < lines.length) {
        const l = lines[i];
        if (l.trim() === "") {
          collected.push("");
          i++;
          continue;
        }
        if (indentOf(l) < deeper) break;
        collected.push(l.slice(deeper));
        i++;
      }
      while (collected.length && collected[collected.length - 1].trim() === "") collected.pop();
      nodes.push({ key, value: folded ? foldLines(collected) : collected.join("\n") });
      recognized++;
      continue;
    }

    if (rest.startsWith("[")) {
      nodes.push({ key, value: splitInlineList(rest.replace(/^\[/, "").replace(/\]\s*$/, "")) });
      recognized++;
      continue;
    }

    nodes.push({ key, value: cleanScalar(rest) });
    recognized++;
  }
  return recognized === 0 ? null : nodes;
}

/** HTML 转义：frontmatter 的 key / value 都可能是用户随口写的任意字符 */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderNode(node: FmNode): string {
  if (node.key === "") {
    // 根级 `- ` 列表
    const lis = (node.value as string[]).map((v) => `<li>${esc(v)}</li>`).join("");
    return `<ul class="md-fm-list">${lis}</ul>`;
  }
  const key = `<span class="md-fm-key">${esc(node.key)}</span>`;
  if (typeof node.value === "string") {
    return `<div class="md-fm-row">${key}<div class="md-fm-value">${esc(node.value)}</div></div>`;
  }
  if (Array.isArray(node.value) && node.value.length > 0 && typeof node.value[0] === "string") {
    const lis = (node.value as string[]).map((v) => `<li>${esc(v)}</li>`).join("");
    return `<div class="md-fm-row">${key}<ul class="md-fm-list">${lis}</ul></div>`;
  }
  // 空列表或嵌套 map
  const nested = Array.isArray(node.value) ? (node.value as FmNode[]) : [];
  return `<div class="md-fm-row">${key}<div class="md-fm-nested">${nested
    .map(renderNode)
    .join("")}</div></div>`;
}

/**
 * 提取 frontmatter。仅当第一行是 `---`、后面存在独立一行闭合 `---`，
 * 且分隔符之间至少能识别出一个 `key:` / `- ` 条目时才认；
 * 否则整篇按普通 markdown 处理——绝不吃掉正文，也避免把「两条水平线夹一段话」
 * 误判成 frontmatter（智能体回复、普通文本都可能长这样）。
 */
function extractFrontmatter(
  text: string,
): { nodes: FmNode[]; body: string; bodyLine: number } | null {
  const lines = text.split(/\r?\n/);
  if (lines.length === 0 || !FM_FENCE.test(lines[0])) return null;
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (FM_FENCE.test(lines[i])) {
      close = i;
      break;
    }
  }
  if (close === -1) return null;
  const nodes = parseYamlBlock(lines.slice(1, close));
  if (!nodes || nodes.length === 0) return null;
  // body 从闭合 `---` 的下一行开始；行号是 1-based，所以是下标 close + 2
  return { nodes, body: lines.slice(close + 1).join("\n"), bodyLine: close + 2 };
}

/**
 * 渲染成能直接交给 dangerouslySetInnerHTML 的 HTML。
 * 必须过一遍 DOMPurify：编辑的是本地文件，但内容不一定可信（clone 下来的 README 就是别人写的），
 * 里面塞一个 <img onerror> 就能在 WebView 里跑脚本。
 *
 * frontmatter 单独结构化成区块再拼回正文：交给 marked 的话，开头的 `---` 会被当成
 * <hr>、YAML 行被当成段落，糊成一大片裸文本。这里自己解析、自己转义，最后整块再
 * 过一遍 sanitize（前端不再有第二次净化机会，所以不能省）。
 */
export function renderMarkdown(text: string, options: RenderOptions = {}): string {
  const fm = extractFrontmatter(text);
  const body = fm ? fm.body : text;
  const baseLine = fm ? fm.bodyLine : 1;
  const { filePath, roots } = options;
  const resolveImage =
    filePath && roots && roots.length > 0
      ? (src: string) => resolveImageSource(src, filePath, roots)
      : undefined;

  const tokens = md.lexer(body);
  const lineOf = options.sourceLines ? annotateTokens(tokens, body, baseLine) : null;
  // KaTeX 扩展渲染器从 activeSourceLines 取公式块行号；普通预览时是 null，等于不处理
  activeSourceLines = lineOf;
  let bodyHtml: string;
  try {
    bodyHtml = md.parser(tokens, { ...md.defaults, renderer: new PreviewRenderer(lineOf) });
  } finally {
    activeSourceLines = null;
  }

  if (!fm) return sanitize(bodyHtml, resolveImage);
  const attr = options.sourceLines ? ' data-src-line="1"' : "";
  const block = `<div class="md-frontmatter"${attr}>${fm.nodes.map(renderNode).join("")}</div>`;
  return sanitize(block + bodyHtml, resolveImage);
}
