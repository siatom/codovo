import type { Options, Plugin } from "prettier";

/**
 * 格式化引擎 —— 直接复用社区事实标准 Prettier，不自己造 formatter。
 *
 * 选型理由：Prettier 官方提供浏览器版 `prettier/standalone`，它依赖闭合、内部不做任何
 * 动态 import，因此每个语言插件都能被 Vite 切成独立 chunk，只有真正执行格式化时才下载——
 * 与「首屏只加载必要代码、其余按需分包」的取舍一致。
 *
 * 覆盖语言与 Prettier 核心插件一一对应：JS / JSX / TS / TSX / JSON(C/5) / CSS / SCSS /
 * Less / HTML / Vue / Markdown / MDC / MDX / YAML / GraphQL。其余语言（Rust / Go / Python
 * 等）不在 Prettier 能力范围内，由上层退回「按语法重排缩进」。
 *
 * 保存前语法校验（`validateText`）复用同一套「扩展名 → parser + 插件」映射，
 * 避免两处规则各写一份而漂移。
 */

/** 插件模块的命名空间对象本身就是合法的 Prettier 插件，直接按需动态导入 */
type PluginLoader = () => Promise<Plugin>;

const PLUGIN_LOADERS: Record<string, PluginLoader> = {
  babel: () => import("prettier/plugins/babel"),
  estree: () => import("prettier/plugins/estree"),
  typescript: () => import("prettier/plugins/typescript"),
  postcss: () => import("prettier/plugins/postcss"),
  html: () => import("prettier/plugins/html"),
  markdown: () => import("prettier/plugins/markdown"),
  yaml: () => import("prettier/plugins/yaml"),
  graphql: () => import("prettier/plugins/graphql"),
};

type PluginName = keyof typeof PLUGIN_LOADERS;

interface LanguageGroup {
  /** 适用的文件扩展名（小写、无前导点） */
  extensions: string[];
  /** Prettier parser 名（取自各插件实际导出的 parsers 键） */
  parser: string;
  /** 该 parser 需要装载的插件；JS/TS/JSON 的打印器在 estree 里，必须一并带上 */
  plugins: PluginName[];
}

/**
 * JS / TS / JSON 的解析器在 babel / typescript 插件里，打印器却在 estree 里，必须成对加载。
 * HTML / Vue 与 Markdown 顺手带上 babel + estree，这样 `<script>` 与 ```js 围栏里的代码
 * 也会被一并格式化（Prettier 只在对应插件已加载时才处理嵌入语言）。
 */
const GROUPS: LanguageGroup[] = [
  { extensions: ["js", "jsx", "mjs", "cjs"], parser: "babel", plugins: ["babel", "estree"] },
  {
    extensions: ["ts", "tsx", "mts", "cts"],
    parser: "typescript",
    plugins: ["typescript", "estree"],
  },
  { extensions: ["json"], parser: "json", plugins: ["babel", "estree"] },
  { extensions: ["json5"], parser: "json5", plugins: ["babel", "estree"] },
  { extensions: ["jsonc"], parser: "jsonc", plugins: ["babel", "estree"] },
  { extensions: ["css"], parser: "css", plugins: ["postcss"] },
  { extensions: ["scss"], parser: "scss", plugins: ["postcss"] },
  { extensions: ["less"], parser: "less", plugins: ["postcss"] },
  { extensions: ["html", "htm"], parser: "html", plugins: ["html", "babel", "estree"] },
  { extensions: ["vue"], parser: "vue", plugins: ["html", "babel", "estree"] },
  {
    extensions: ["md", "markdown", "mkd", "mkdn", "mdown", "mdc"],
    parser: "markdown",
    plugins: ["markdown", "babel", "estree"],
  },
  { extensions: ["mdx"], parser: "mdx", plugins: ["markdown", "babel", "estree"] },
  { extensions: ["yaml", "yml"], parser: "yaml", plugins: ["yaml"] },
  { extensions: ["graphql", "gql"], parser: "graphql", plugins: ["graphql"] },
];

/** 扩展名 -> 语言分组，避免每次格式化都线性查找 */
const SPECS = new Map<string, LanguageGroup>();
for (const group of GROUPS) {
  for (const ext of group.extensions) SPECS.set(ext, group);
}

/** 取小写扩展名（不含点）。路径末段没有点、或以点开头（如 `.gitignore`）都算没有扩展名 */
function extensionOf(filename: string): string {
  const name = filename.replace(/\\/g, "/").split("/").pop() ?? filename;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** 该文件名是否在 Prettier 的覆盖范围内（决定用 Prettier 还是退回缩进重排） */
export function supportsFormatting(filename: string | null | undefined): boolean {
  return !!filename && SPECS.has(extensionOf(filename));
}

/**
 * 能不能对这个打开的文件格式化。二进制 / 只读 / 截断 / 超大都不做——
 * 格式化会重写整篇正文，这几类文件要么不该改、要么改不动。
 */
export function canFormatTab(
  flags: { readOnly: boolean; truncated: boolean; isLarge: boolean } | null | undefined,
): boolean {
  return !!flags && !flags.readOnly && !flags.truncated && !flags.isLarge;
}

export interface FormatRequest {
  /** 编辑器缩进宽度 */
  tabWidth: number;
  /** 传入时同步映射光标位置（对齐 Prettier 的编辑器集成做法） */
  cursorOffset?: number;
}

export interface FormatOutcome {
  text: string;
  /** 映射后的光标偏移；未请求映射时为 null */
  cursorOffset: number | null;
}

/** Prettier 主程序 + 已装载的语言插件 + 当前文件的 parser 名 */
interface FormatEngine {
  prettier: typeof import("prettier/standalone");
  plugins: Plugin[];
  parser: string;
}

/**
 * 按扩展名装载 Prettier 主程序与对应语言插件。
 * 格式化与语法校验共用同一套「文件类型 → parser + 插件」映射，避免两处规则漂移。
 */
async function loadEngine(filename: string): Promise<FormatEngine> {
  const ext = extensionOf(filename);
  const group = SPECS.get(ext);
  if (!group) throw new Error(`暂不支持格式化 .${ext || "?"} 文件`);

  const [prettier, plugins] = await Promise.all([
    import("prettier/standalone"),
    Promise.all(group.plugins.map((name) => PLUGIN_LOADERS[name]())),
  ]);
  return { prettier, plugins, parser: group.parser };
}

/**
 * 用 Prettier 格式化文本。
 * - 不支持的文件类型 / 源码有语法错误时抛错，由调用方决定降级策略
 * - 编辑器内容统一为 LF，格式化结果同样保持 LF（`endOfLine: "lf"`）
 */
export async function formatText(
  source: string,
  filename: string,
  request: FormatRequest,
): Promise<FormatOutcome> {
  const { prettier, plugins, parser } = await loadEngine(filename);

  const config: Options = {
    parser,
    plugins,
    tabWidth: request.tabWidth,
    useTabs: false,
    endOfLine: "lf",
  };

  if (request.cursorOffset === undefined) {
    return { text: await prettier.format(source, config), cursorOffset: null };
  }

  const { formatted, cursorOffset } = await prettier.formatWithCursor(source, {
    ...config,
    cursorOffset: request.cursorOffset,
  });
  return { text: formatted, cursorOffset };
}

/** 语法问题（位置为 1-based；解析器未给出位置时为 null） */
export interface SyntaxIssue {
  /** 首行报错文案，已剥离尾部的“(行:列)” */
  message: string;
  line: number | null;
  column: number | null;
}

/**
 * Prettier 的语法错误固定是 SyntaxError，且大多带结构化的 `loc.start`；
 * 优先取结构化位置，个别解析器缺失时退回从消息尾部的“(行:列)”解析。
 */
function toSyntaxIssue(err: unknown): SyntaxIssue {
  const raw = err instanceof Error ? err.message : String(err);
  const firstLine = (raw.split("\n")[0] ?? "").trim();

  const start = (err as { loc?: { start?: { line?: number; column?: number } } } | null)?.loc
    ?.start;
  let line = typeof start?.line === "number" ? start.line : null;
  let column = typeof start?.column === "number" ? start.column : null;

  if (line === null || column === null) {
    const matched = firstLine.match(/\((\d+):(\d+)\)\s*$/);
    if (matched) {
      line = Number(matched[1]);
      column = Number(matched[2]);
    }
  }

  const message = firstLine.replace(/\s*\(\d+:\d+\)\s*$/, "").trim() || "语法错误";
  return { message, line, column };
}

/**
 * 仅做语法校验 —— 复用与格式化完全相同的解析器，只关心「解析是否失败」，丢弃格式化输出。
 *
 * 这样 JSON / JSONC / JSON5 / YAML / JS / TS / CSS / HTML / Markdown / GraphQL 等
 * 都被同一套社区事实标准覆盖，无需自己实现任何解析逻辑。
 * 返回 null 表示语法合法，或该类型不在 Prettier 覆盖范围内（无从校验）。
 */
export async function validateText(source: string, filename: string): Promise<SyntaxIssue | null> {
  if (!supportsFormatting(filename)) return null;

  let engine: FormatEngine;
  try {
    engine = await loadEngine(filename);
  } catch {
    return null;
  }

  try {
    await engine.prettier.format(source, {
      parser: engine.parser,
      plugins: engine.plugins,
      endOfLine: "lf",
    });
    return null;
  } catch (err) {
    return toSyntaxIssue(err);
  }
}

/** 把语法问题的位置拼成中文提示，如「（第 3 行 第 5 列）」；解析器没给位置时返回空串 */
export function formatIssueLocation(issue: SyntaxIssue): string {
  if (issue.line === null) return "";
  const column = issue.column === null ? "" : ` 第 ${issue.column} 列`;
  return `（第 ${issue.line} 行${column}）`;
}

/** Prettier 的报错常带一段 codeframe，只取首行给用户看 */
export function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.split("\n")[0]?.trim() || "未知错误";
}
