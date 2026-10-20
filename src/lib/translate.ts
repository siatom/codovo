import { languageOf } from "./languages";
import type { TranslateTarget } from "./types";

export type { TranslateTarget };

/**
 * 文档翻译的前端分段与内容保护。
 *
 * 只负责把一篇文档拆成适合单次请求的片段，并把代码块、目录、链接引用等不该
 * 交给模型的内容换成占位符；真正的网络请求在 `lib/ai.ts` / Rust 侧完成。
 * 算法与 CodeLite 保持一致，占位符前缀换成 CodeDock 自己的，避免两边的缓存
 * 或模型输出混用。
 */

/** 单次翻译请求的字符上限；按空行/段落切块，既贴近上下文限制也方便显示进度 */
export const TRANSLATE_CHUNK_CHARS = 6000;
/** 表格尽量整块发送，避免表头与数据行被拆到不同请求 */
const MAX_TABLE_CHUNK_CHARS = 38_000;
/** 整篇文档的翻译上限，防止误点后产生成百上千次请求 */
export const MAX_TRANSLATE_CHARS = 200_000;

/** 文档翻译只对这些扩展名开放；源码、脚本和配置文件一律不显示入口 */
const DOCUMENT_EXTENSIONS = new Set([
  "md",
  "markdown",
  "mdc",
  "mdx",
  "mdown",
  "mdtext",
  "mdtxt",
  "mdwn",
  "mkd",
  "mkdn",
  "txt",
  "text",
  "log",
  "rst",
  "adoc",
  "asciidoc",
]);

const MARKER_PREFIX = "CODEDOCK_CODE_";

/** 占位符：用少见的括号包住，模型更容易原样保留 */
function marker(index: number): string {
  return `⟦${MARKER_PREFIX}${index}⟧`;
}

/** 宽松匹配占位符，容忍模型把两侧括号换成别的成对符号 */
const MARKER_RE = /[⟦\[(【]?\s*CODEDOCK_CODE_(\d+)\s*[⟧\])】]?/g;

export interface PreparedDocument {
  /** 已屏蔽代码块、可直接发给模型的片段 */
  chunks: string[];
  /** 被屏蔽的原始内容，按占位符序号索引 */
  blocks: string[];
}

/**
 * 文档内容签名。只需要判断「内容是否变过」，用长度 + FNV-1a 即可，
 * 不必对整篇文档做 SHA。
 */
export function contentSignature(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${text.length}:${(hash >>> 0).toString(16)}`;
}

/** 路径是否属于可翻译的文档类型。未命名缓冲区没有扩展名，暂不开放 */
export function isDocumentPath(path: string | null): boolean {
  if (path === null) return false;
  const name = path.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  const dot = name.lastIndexOf(".");
  return dot >= 0 && DOCUMENT_EXTENSIONS.has(name.slice(dot + 1));
}

/** 文档是否按 Markdown 渲染（含 mdc / mdx）；其余文档按纯文本显示 */
export function isMarkdownDocument(path: string | null): boolean {
  if (path === null) return false;
  const language = languageOf(path);
  return language === "markdown" || language === "mdx";
}

/** 目标语言的可读名称，界面按钮与状态文案共用 */
export function translateTargetLabel(target: TranslateTarget): string {
  return target === "zh" ? "简体中文" : "English";
}

interface ShieldedSource {
  text: string;
  blocks: string[];
}

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/**
 * 按空行分块后，对满足条件的整块原样保留。
 * 这样目录、文件树这类「结构块」不会被拆散，也不会被模型改写成自然语言。
 */
function shieldPatternBlocks(
  text: string,
  keep: (raw: string) => string,
  shouldShield: (block: string) => boolean,
): string {
  return text
    .split(/(\n{2,})/)
    .map((part, index) => (index % 2 === 0 && shouldShield(part) ? keep(part) : part))
    .join("");
}

/** 文件/目录树：包含树形连接符的块（根目录 + 至少一个子项） */
function isDirectoryTreeBlock(block: string): boolean {
  const lines = block.split("\n").filter((line) => line.trim() !== "");
  if (lines.length < 2) return false;
  const treeLines = lines.filter(
    (line) => /^\s*[├└│]/.test(line) || /^\s*[+|`]-{2,}/.test(line),
  );
  return treeLines.length >= 1;
}

/** Markdown 表格分隔行，如 `| --- | :---: |` */
function isTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

/** 判断块里是否包含 Markdown 表格（表头 + 分隔行） */
function isTableBlock(block: string): boolean {
  const lines = block.split("\n");
  return lines.some(
    (line, index) =>
      index > 0 && line.includes("|") && lines[index - 1].includes("|") && isTableSeparator(line),
  );
}

/** 缩进/逐行罗列的路径清单（没有树形连接符的目录结构） */
function isPathListBlock(block: string): boolean {
  const lines = block.split("\n").filter((line) => line.trim() !== "");
  if (lines.length < 3) return false;
  const pathLines = lines.filter((line) =>
    /^\s*[\w.@+-]+(?:[/\\][\w.@+-]*)*[/\\]?\s*$/.test(line),
  );
  const hasSlash = lines.some((line) => /[/\\]/.test(line));
  return hasSlash && pathLines.length >= lines.length - 1;
}

/** Markdown 目录（TOC）：整块几乎都是锚点列表或带点线页码的条目 */
function isTocBlock(block: string): boolean {
  const lines = block.split("\n").filter((line) => line.trim() !== "");
  if (lines.length < 2) return false;

  const tocLines = lines.filter((line) =>
    /^\s*(?:[-*+]|\d+[.)])\s+\[[^\]]+\]\(#[^)]+\)\s*$/.test(line),
  );
  if (tocLines.length >= 2 && tocLines.length >= lines.length - 1) return true;

  // 纯文本目录：`第一章 ........ 1`
  const dotLeaderLines = lines.filter((line) => /\.{3,}\s*\d+\s*$/.test(line));
  return dotLeaderLines.length >= 2 && dotLeaderLines.length >= lines.length - 1;
}

/** 链接引用定义，如 `[docs]: https://example.com` */
function isLinkDefinitionBlock(block: string): boolean {
  const lines = block.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0 || !/^\s*\[[^\]]+\]:\s*\S+/.test(lines[0])) return false;
  return lines.every((line) => /^\s*\[[^\]]+\]:\s*\S+/.test(line) || /^\s{2,}\S/.test(line));
}

/** 纯徽章/图片行，通常只承载链接和状态，不应翻译 */
function isBadgeBlock(block: string): boolean {
  const lines = block.split("\n").filter((line) => line.trim() !== "");
  return (
    lines.length > 0 &&
    lines.every(
      (line) =>
        /^\s*(?:\[!\[[^\]]*\]\([^)]+\)\]\([^)]+\)\s*)+$/.test(line) ||
        /^\s*!\[[^\]]*\]\([^)]+\)\s*$/.test(line),
    )
  );
}

/** 用来区分「缩进代码」与「缩进列表续行」的代码特征 */
const CODE_SIGNAL_RE =
  /[{};=<>]|=>|::|#include|\/\*|\*\/|\/\/|^\s*(?:const|let|var|function|class|def|import|export|return|if|else|for|while|switch|try|catch|public|private|protected|static|void|int|string|bool|SELECT|INSERT|UPDATE|DELETE|npm|pnpm|yarn|git|cd|ls|echo|curl|docker|kubectl|python|node|cargo|go|mvn|make)\b/m;

/** 缩进代码块：整块至少 4 空格或 Tab 开头，且含代码特征（避免误伤缩进列表） */
function shieldIndentedCode(text: string, keep: (raw: string) => string): string {
  return text
    .split(/(\n{2,})/)
    .map((part, index) => {
      if (index % 2 !== 0) return part;
      const lines = part.split("\n").filter((line) => line.trim() !== "");
      if (lines.length === 0) return part;
      const indented = lines.every((line) => /^(?: {4}|\t)/.test(line));
      return indented && CODE_SIGNAL_RE.test(part) ? keep(part) : part;
    })
    .join("");
}

/** 逐行扫描围栏代码块，避免正则处理「闭合围栏比开启更长」或未闭合时的误伤 */
function shieldFences(text: string, keep: (raw: string) => string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const open = FENCE_OPEN_RE.exec(lines[i]);
    if (!open) {
      out.push(lines[i]);
      i++;
      continue;
    }

    const start = i;
    const fenceChar = open[1][0];
    const fenceLength = open[1].length;
    i++;

    while (i < lines.length) {
      const close = FENCE_CLOSE_RE.exec(lines[i]);
      if (close && close[1][0] === fenceChar && close[1].length >= fenceLength) {
        i++;
        break;
      }
      i++;
    }

    out.push(keep(lines.slice(start, i).join("\n")));
  }

  return out.join("\n");
}

/** 取出应在翻译时原样保留的代码/元数据，替换成短占位符 */
function shieldSource(source: string): ShieldedSource {
  const blocks: string[] = [];
  let text = source.replace(/\r\n?/g, "\n");

  const keep = (raw: string): string => {
    const index = blocks.length;
    blocks.push(raw);
    return marker(index);
  };

  // YAML frontmatter：保留原文，避免模型改坏键名
  text = text.replace(/^\uFEFF?---[ \t]*\n[\s\S]*?\n---[ \t]*(?=\n|$)/, (raw) => keep(raw));

  text = shieldFences(text, keep);

  // HTML 里的代码块、注释与导航（导航通常就是目录）
  text = text.replace(/<(pre|code)\b[^>]*>[\s\S]*?<\/\1>/gi, (raw) => keep(raw));
  text = text.replace(/<!--[\s\S]*?-->/g, (raw) => keep(raw));
  text = text.replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, (raw) => keep(raw));
  text = shieldIndentedCode(text, keep);

  // 目录、文件树、链接引用与徽章：保留结构，不交给模型改写
  text = shieldPatternBlocks(text, keep, isDirectoryTreeBlock);
  text = shieldPatternBlocks(text, keep, isPathListBlock);
  text = shieldPatternBlocks(text, keep, isTocBlock);
  text = shieldPatternBlocks(text, keep, isLinkDefinitionBlock);
  text = shieldPatternBlocks(text, keep, isBadgeBlock);

  // Markdown 行内代码，如 `npm run build`
  text = text.replace(/(`+)([^\n]*?)\1/g, (raw) => keep(raw));

  return { text, blocks };
}

/** 按空行拆分段落；即使遇到未屏蔽的围栏，也不会在代码块内部断开 */
function splitBlocks(source: string): string[] {
  const blocks: string[] = [];
  let buffer: string[] = [];
  let fence: string | null = null;

  const flush = () => {
    const text = buffer.join("\n").trim();
    if (text) blocks.push(text);
    buffer = [];
  };

  for (const line of source.split("\n")) {
    const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (match) {
      if (!fence) fence = match[1][0];
      else if (match[1][0] === fence) fence = null;
    }

    if (!fence && line.trim() === "") {
      flush();
      continue;
    }
    buffer.push(line);
  }
  flush();
  return blocks;
}

/** 单行里所有占位符的 [start, end) 区间，用来避免硬切时把占位符切成两半 */
function markerSpans(line: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  // MARKER_RE 带 g 标志，先归零 lastIndex，避免沿用上一次匹配的位置
  MARKER_RE.lastIndex = 0;
  for (const match of line.matchAll(MARKER_RE)) {
    const start = match.index ?? 0;
    spans.push([start, start + match[0].length]);
  }
  MARKER_RE.lastIndex = 0;
  return spans;
}

/**
 * 给超长行找一个不切断占位符的切点。
 *
 * 首选离 `limit` 最近的边界；如果落点正好在 `⟦CODEDOCK_CODE_n⟧` 里，就退到
 * 占位符起点或进到终点，二者取偏离上限更小的那个——退得太靠前会让片段明显
 * 变短，进得太多又可能超过上下文限制，折中即可。
 */
function safeLineEnd(line: string, start: number, limit: number, spans: Array<[number, number]>): number {
  let end = Math.min(line.length, start + limit);
  // 不要把一个 surrogate pair 切成两半
  if (end < line.length && /[\uD800-\uDBFF]/.test(line[end - 1])) end -= 1;

  if (end < line.length) {
    const hit = spans.find(([from, to]) => end > from && end < to);
    if (hit) {
      const [from, to] = hit;
      const canRetreat = from > start;
      const canAdvance = to <= line.length;
      if (canRetreat && canAdvance) {
        end = limit - (from - start) <= to - start - limit ? from : to;
      } else if (canRetreat) {
        end = from;
      } else if (canAdvance) {
        end = to;
      }
    }
  }

  // 极端情况下（占位符正好从 start 开始、或上限比一个占位符还短）至少保证往前走
  return end > start ? end : Math.min(line.length, start + limit);
}

/** 单行/单段超过上限时按行、再按字符硬切，保证每块都能塞进上下文 */
function splitOversized(block: string, limit: number): string[] {
  const out: string[] = [];
  let current = "";

  const flush = () => {
    if (current.trim()) out.push(current.trim());
    current = "";
  };

  for (const line of block.split("\n")) {
    if (line.length > limit) {
      flush();
      const spans = markerSpans(line);
      let start = 0;
      while (start < line.length) {
        const end = safeLineEnd(line, start, limit, spans);
        const part = line.slice(start, end).trim();
        if (part) out.push(part);
        // 上一段若退到了占位符起点，下一段从那里开始、完整包住它；进到终点时
        // 下一段也从终点开始。两种情况都不会让 start 落在占位符内部。
        start = end;
      }
      continue;
    }

    if (current && current.length + line.length + 1 > limit) flush();
    current = current ? `${current}\n${line}` : line;
  }
  flush();
  return out;
}

/** 把文档切成若干不超过 `limit` 字符的片段，并屏蔽其中的代码 */
export function prepareDocument(source: string, limit = TRANSLATE_CHUNK_CHARS): PreparedDocument {
  const shielded = shieldSource(source);
  const chunks: string[] = [];
  let current = "";

  for (const block of splitBlocks(shielded.text)) {
    // 表格保持完整：表头、对齐行与数据行必须在同一次请求里
    if (isTableBlock(block) && block.length > limit) {
      if (block.length > MAX_TABLE_CHUNK_CHARS) {
        throw new Error("表格内容超过 38k 字符，请拆分表格后再翻译");
      }
      if (current) {
        chunks.push(current);
        current = "";
      }
      chunks.push(block);
      continue;
    }

    if (block.length > limit) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      chunks.push(...splitOversized(block, limit));
      continue;
    }

    if (current && current.length + block.length + 2 > limit) {
      chunks.push(current);
      current = block;
    } else {
      current = current ? `${current}\n\n${block}` : block;
    }
  }

  if (current) chunks.push(current);
  return { chunks, blocks: shielded.blocks };
}

/** 去掉代码/目录占位符后是否还有真正需要翻译的正文 */
export function hasTranslatableProse(chunks: string[]): boolean {
  return (
    chunks
      .join("")
      .replace(MARKER_RE, "")
      .replace(/[\s#>*_~|`-]/g, "").length > 0
  );
}

/** 翻译进行中展示已完成片段时使用：还原当前已有的占位符，未到达的块自然不出现 */
export function previewTranslation(parts: string[], blocks: string[]): string {
  return parts
    .join("\n\n")
    .replace(MARKER_RE, (_raw, indexText: string) => blocks[Number(indexText)] ?? "")
    .trim();
}

/**
 * 把各片段译文拼回整篇，并还原被屏蔽的代码块。
 *
 * 占位符缺失、重复、越界或顺序被打乱都视为翻译失败：宁可报错重试，
 * 也不能把原文的代码块吞掉或留下空洞。顺序检查同时覆盖「模型把占位符
 * 挪到别的段落」这种错位情况。
 */
export function assembleTranslation(parts: string[], blocks: string[]): string {
  const joined = parts.join("\n\n");
  const seen = new Set<number>();
  let invalid = false;
  let duplicated = false;
  let misplaced = false;
  let last = -1;

  const restored = joined.replace(MARKER_RE, (raw, indexText: string) => {
    const index = Number(indexText);
    if (!Number.isInteger(index) || index < 0 || index >= blocks.length) {
      invalid = true;
      return raw;
    }
    if (seen.has(index)) duplicated = true;
    if (index < last) misplaced = true;
    last = Math.max(last, index);
    seen.add(index);
    return blocks[index];
  });

  if (invalid) throw new Error("翻译结果里出现了无法识别的占位符，请重试");
  if (duplicated) throw new Error("翻译结果重复了代码块占位符，请重试");
  if (seen.size !== blocks.length) {
    throw new Error("翻译结果未能完整保留文档中的代码块，请重试");
  }
  if (misplaced) throw new Error("翻译结果打乱了代码块占位符的顺序，请重试");

  return restored.trim();
}
