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

export function languageOf(path: string): string {
  const name = path.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  if (BY_FILENAME[name]) return BY_FILENAME[name];

  const ext = name.includes(".") ? name.split(".").pop()! : "";
  return BY_EXTENSION[ext] ?? "plaintext";
}
