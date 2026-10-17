import DOMPurify from "dompurify";
import { Marked } from "marked";
import markedKatex from "marked-katex-extension";

/**
 * 预览用的 markdown 渲染器。
 * async 必须显式关掉：异步模式下 parse 返回 Promise，这里要的是同步拿字符串。
 * gfm 本来就是默认值，写出来是为了说明表格、任务列表、删除线都支持。
 *
 * 数学公式走 KaTeX。`nonStandard` 让 `$x^2$` 这种不加空格的写法也能认出来——
 * 技术文档里几乎没人会在公式两侧刻意留空格；代价是 `$5` 这类金额偶尔会被当成公式，
 * 但 `throwOnError: false` 会把它原样留下来，不至于把整篇预览搞崩。
 */
const md = new Marked({ async: false, gfm: true });
md.use(markedKatex({ throwOnError: false, nonStandard: true }));

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

function sanitize(html: string): string {
  return DOMPurify.sanitize(html, SANITIZE_OPTIONS);
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
function extractFrontmatter(text: string): { nodes: FmNode[]; body: string } | null {
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
  return { nodes, body: lines.slice(close + 1).join("\n") };
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
export function renderMarkdown(text: string): string {
  const fm = extractFrontmatter(text);
  if (!fm) return sanitize(md.parse(text) as string);
  const block = `<div class="md-frontmatter">${fm.nodes.map(renderNode).join("")}</div>`;
  const bodyHtml = md.parse(fm.body) as string;
  return sanitize(block + bodyHtml);
}
