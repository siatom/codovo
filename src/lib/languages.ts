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
  log: "plaintext",
  lua: "lua",
  md: "markdown",
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
};

export function languageOf(path: string): string {
  const name = path.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  if (BY_FILENAME[name]) return BY_FILENAME[name];

  const ext = name.includes(".") ? name.split(".").pop()! : "";
  return BY_EXTENSION[ext] ?? "plaintext";
}
