import { cliKey } from "./cli-sessions";

/**
 * 一家 AI CLI 怎么接受「附加工作目录」。
 *
 * 参数与形态都按各家官方文档（2026-10 核对）：
 * - Claude Code / CodeBuddy：`--add-dir <dir...>`，一个参数后面可以跟多个目录
 * - Codex / Antigravity：`--add-dir <dir>`，每个目录重复一次参数
 * - GitHub Copilot CLI：`--add-dir=<dir>`，每个目录重复一次
 * - Gemini CLI / Qwen Code / iFlow CLI：`--include-directories <dir>`，每个目录重复一次
 *
 * opencode 目前没有等价的启动参数（只有配置里的 `permission.external_directory`），
 * 所以不在表里；认不出来的一律原样启动。
 */
interface AdditionalDirsSpec {
  /** 命令里的可执行文件名 / 别名，经 cliKey 归一化后比较 */
  commands: string[];
  /** 参数名 */
  flag: string;
  /**
   * 多个目录怎么拼：
   * - list：`--add-dir a b`（一次列全）
   * - repeat：`--add-dir a --add-dir b`（逐个重复）
   * - equals：`--add-dir=a --add-dir=b`（逐个重复且用等号）
   */
  style: "list" | "repeat" | "equals";
}

const ADDITIONAL_DIRS_SPECS: AdditionalDirsSpec[] = [
  { commands: ["claude", "claude-code"], flag: "--add-dir", style: "list" },
  { commands: ["codebuddy", "codebuddy-code"], flag: "--add-dir", style: "list" },
  { commands: ["codex"], flag: "--add-dir", style: "repeat" },
  { commands: ["agy", "antigravity"], flag: "--add-dir", style: "repeat" },
  { commands: ["copilot"], flag: "--add-dir", style: "equals" },
  { commands: ["gemini", "gemini-cli"], flag: "--include-directories", style: "repeat" },
  { commands: ["qwen", "qwen-code"], flag: "--include-directories", style: "repeat" },
  { commands: ["iflow", "iflow-cli"], flag: "--include-directories", style: "repeat" },
];

/**
 * 工作区的附加目录 -> 启动参数。
 *
 * 返回拼好的完整命令；调用方拿它去新开终端。认不出是哪家 CLI、目录为空、
 * 或者用户自己已经在命令里写了同名参数时，原样返回——不猜、不重复注入。
 *
 * 路径一律加引号：附加目录可能带空格，命令是直接写进 shell 的，不引会被拆成两个词。
 */
export function withAdditionalDirs(command: string, dirs: string[]): string {
  if (dirs.length === 0) return command;

  const spec = specOf(command);
  if (!spec) return command;
  if (hasFlag(command, spec.flag)) return command;

  return insertArgs(command, formatArgs(spec, dirs));
}

function specOf(command: string): AdditionalDirsSpec | null {
  const words = command.trim().split(/\s+/).map(cliKey);
  return (
    ADDITIONAL_DIRS_SPECS.find((item) =>
      item.commands.some((name) => words.includes(name)),
    ) ?? null
  );
}

/** 命令里是不是已经有这个参数（`--flag` / `--flag=value` 都算） */
function hasFlag(command: string, flag: string): boolean {
  const quoted = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\s)${quoted}(=|\\s|$)`).test(command);
}

function formatArgs(spec: AdditionalDirsSpec, dirs: string[]): string {
  const paths = dirs.map(quotePath);
  if (spec.style === "list") return `${spec.flag} ${paths.join(" ")}`;
  if (spec.style === "equals") {
    return paths.map((path) => `${spec.flag}=${path}`).join(" ");
  }
  return paths.map((path) => `${spec.flag} ${path}`).join(" ");
}

/**
 * 把参数插到命令里。有 `--` 分隔符时插在它前面：后面是用户自己的 prompt，
 * 追加在末尾会被 CLI 当成 prompt 的一部分。
 */
function insertArgs(command: string, args: string): string {
  const separator = command.search(/(^|\s)--(\s|$)/);
  if (separator < 0) return `${command} ${args}`;

  const head = command.slice(0, separator).trimEnd();
  const tail = command.slice(separator).trimStart();
  return `${head} ${args} ${tail}`;
}

/**
 * 按当前平台给路径加引号。
 *
 * POSIX 用单引号，`$` / 反引号 / 空格都按字面量传；路径里的单引号用
 * `'\''` 收尾再续上。Windows 下 cmd 只认双引号，PowerShell 也认；
 * 路径末尾的反斜杠在 Git Bash 里会吃掉右引号，补一个让它按字面量落地。
 */
function quotePath(path: string): string {
  if (/windows/i.test(navigator.userAgent)) {
    return `"${path.endsWith("\\") ? `${path}\\` : path}"`;
  }
  return `'${path.replace(/'/g, `'\\''`)}'`;
}
