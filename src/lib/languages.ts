const BY_EXTENSION: Record<string, string> = {
  bat: "bat",
  c: "c",
  cc: "cpp",
  cfg: "ini",
  cmd: "bat",
  conf: "ini",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  dockerfile: "dockerfile",
  env: "ini",
  go: "go",
  h: "cpp",
  hpp: "cpp",
  html: "html",
  ini: "ini",
  java: "java",
  js: "javascript",
  json: "json",
  json5: "json5",
  jsonc: "jsonc",
  jsx: "javascript",
  less: "less",
  mk: "makefile",
  log: "plaintext",
  lua: "lua",
  md: "markdown",
  // .mdc 是带 frontmatter 的 markdown 变体（CodeBuddy 规则文件），预览链路照 markdown 走
  mdc: "markdown",
  mjs: "javascript",
  php: "php",
  ps1: "powershell",
  py: "python",
  rb: "ruby",
  rs: "rust",
  scss: "scss",
  sh: "shell",
  sql: "sql",
  svg: "xml",
  toml: "ini",
  ts: "typescript",
  tsx: "typescript",
  txt: "plaintext",
  vue: "html",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "shell",
};

const BY_FILENAME: Record<string, string> = {
  dockerfile: "dockerfile",
  "cargo.lock": "ini",
  makefile: "makefile",
  gnumakefile: "makefile",
  "cmakelists.txt": "cmake",
  ".gitignore": "ignore",
  ".dockerignore": "ignore",
  ".npmignore": "ignore",
  ".eslintignore": "ignore",
  ".prettierignore": "ignore",
  ".hgignore": "ignore",
};

// 下面这些 .json 的宿主工具本来就允许注释，属于 JSONC。若交给内置 json 语言，
// 严格解析器会把注释和尾随逗号整片标红、格式化也会直接罢工，所以按文件名/所在目录改判 jsonc。
/** tsconfig.json / jsconfig.json，以及 tsconfig.base.json、tsconfig.node.json 这类变体 */
const JSONC_CONFIG_PATTERN = /^(?:ts|js)config(?:\.[\w.-]+)?\.json$/;
/** 这两个目录下的 .json 都按 JSONC 解析（编辑器与容器工具的约定） */
const JSONC_DIRECTORIES = new Set([".vscode", ".devcontainer"]);

function isJsoncJson(fileName: string, directories: string[]): boolean {
  if (JSONC_CONFIG_PATTERN.test(fileName)) return true;
  return directories.some((dir) => JSONC_DIRECTORIES.has(dir.toLowerCase()));
}

export function languageOf(path: string): string {
  // 路径可能混用分隔符（Windows 上尤其），先归一化再切段：最后一段是文件名，其余是所在目录
  const segments = path.replace(/\\/g, "/").split("/");
  const name = segments.pop()?.toLowerCase() ?? "";
  if (BY_FILENAME[name]) return BY_FILENAME[name];

  const ext = name.includes(".") ? name.split(".").pop()! : "";
  const language = BY_EXTENSION[ext];
  // .json 默认走内置严格 JSON，只有命中上面的配置约定时才改判 JSONC
  if (language === "json" && isJsoncJson(name, segments)) return "jsonc";
  return language ?? "plaintext";
}
