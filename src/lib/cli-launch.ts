import { cliKey } from "./cli-sessions";

/**
 * 启动 AI CLI 前算出来的东西：实际要跑的命令，以及要额外给这个终端进程设的环境变量。
 * 环境变量走 PTY spawn，不拼进 shell 命令——路径和 JSON 里的引号跨平台太难伺候。
 */
export interface PreparedLaunch {
  command: string;
  env: Record<string, string>;
}

/**
 * 一家 AI CLI 怎么接受「附加工作目录」。
 *
 * 参数与形态都按各家官方文档（2026-10 核对）：
 * - Claude Code / CodeBuddy：`--add-dir <dir...>`，一个参数后面可以跟多个目录
 * - Codex / Antigravity / Qoder：`--add-dir <dir>`，每个目录重复一次参数
 * - GitHub Copilot CLI：`--add-dir=<dir>`，每个目录重复一次
 * - Gemini CLI / Qwen Code / iFlow CLI：`--include-directories <dir>`，每个目录重复一次
 *
 * opencode 走配置而不是启动参数，见 prepareOpencode；认不出来的一律原样启动。
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
  // qodercli 的 --add-dir 一次只收一个目录
  { commands: ["qoder", "qodercli"], flag: "--add-dir", style: "repeat" },
  { commands: ["copilot"], flag: "--add-dir", style: "equals" },
  { commands: ["gemini", "gemini-cli"], flag: "--include-directories", style: "repeat" },
  { commands: ["qwen", "qwen-code"], flag: "--include-directories", style: "repeat" },
  { commands: ["iflow", "iflow-cli"], flag: "--include-directories", style: "repeat" },
];

/**
 * 工作区的附加目录 -> 启动命令 + 环境变量。
 *
 * 认不出是哪家 CLI、没有附加目录、或者用户自己已经在命令里写了同名参数时，
 * 原样返回——不猜、不重复注入。opencode 是例外：它没有 `--add-dir`，而且 V2
 * 默认对外部目录全量放行，所以即使没有附加目录也要注入 ask 兜底，把单根工作区
 * 的范围也收住。
 *
 * 路径一律加引号：附加目录可能带空格，命令是直接写进 shell 的，不引会被拆成两个词。
 */
export function prepareLaunch(command: string, dirs: string[]): PreparedLaunch {
  if (isOpencode(command)) return prepareOpencode(command, dirs);
  if (dirs.length === 0) return { command, env: {} };

  const spec = specOf(command);
  if (!spec) return { command, env: {} };
  if (hasFlag(command, spec.flag)) return { command, env: {} };

  return { command: insertArgs(command, formatArgs(spec, dirs)), env: {} };
}

function isOpencode(command: string): boolean {
  return command.trim().split(/\s+/).map(cliKey).includes("opencode");
}

/**
 * 自带多标签页 / 多会话切换的 CLI。opencode 的 TUI 里本来就能开多个会话，
 * 顶栏点它时应该切回已经开着的那个终端，而不是再叠一个重复的标签。
 *
 * 其余 CLI 没有这层能力，多开终端标签是并行跑的唯一办法，所以仍按「每次新开」处理。
 */
const INTERNAL_TAB_CLIS = new Set(["opencode"]);

/** 这条启动命令对应的 CLI 是不是自带多标签页；`npx opencode` 这种写法也认得出来 */
export function hasInternalTabs(command: string): boolean {
  return command
    .trim()
    .split(/\s+/)
    .map(cliKey)
    .some((word) => INTERNAL_TAB_CLIS.has(word));
}

/**
 * opencode 没有 `--add-dir`，权限写在 V2 的 `permissions` 数组里。
 *
 * `external_directory` 的默认策略就是全量 allow，只写几个 allow 规则等于没写。
 * 要真正把范围收紧到工作区，必须先给 `*` 加一条 ask 兜底，再用工作区目录的 allow
 * 例外盖回来——规则按书写顺序匹配，后面的覆盖前面的。`dirs` 为空时只剩 ask 兜底，
 * 正好对应单根工作区：活动根是 Location，本来就不走 external_directory。
 *
 * 这里只兜底 `external_directory`：目录内的 read / edit 仍沿用用户自己的规则，
 * 不拿一个宽泛的 allow 把 `.env` 之类的 deny 盖掉。
 *
 * v2 默认连接用户级共享服务，客户端的环境变量传不过去；加 `--standalone`
 * 让本次终端自己起一个私有服务，配置才会生效。用户显式指定 `--server` 时连的是
 * 外部服务，既传不了配置也不能同时加 `--standalone`，此时不注入。
 */
function prepareOpencode(command: string, dirs: string[]): PreparedLaunch {
  if (hasFlag(command, "--server")) return { command, env: {} };

  const permissions = [
    { action: "external_directory", resource: "*", effect: "ask" as const },
    ...dirs.map((dir) => ({
      action: "external_directory",
      resource: permissionResource(dir),
      effect: "allow" as const,
    })),
  ];
  const env = {
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ permissions }),
  };

  const launched = hasFlag(command, "--standalone")
    ? command
    : insertArgs(command, "--standalone");

  return { command: launched, env };
}

/**
 * `external_directory` 的 resource 是目录边界，规范形式是 `<dir>/*`。
 * 匹配里的 `*` 本身能跨 `/`，所以一条规则就覆盖整棵子树；
 * 盘符根 / 文件系统根会自然拼成 `D:/*`、`/*`，不用特殊处理。
 */
function permissionResource(path: string): string {
  const base = path.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!base) return "/*";
  return `${base}/*`;
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
