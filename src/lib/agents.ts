import { invoke } from "@tauri-apps/api/core";
import type { AiCommand } from "./settings";

/**
 * 系统认识的编程 Agent。这里的 `command` 是**默认启动命令**（也是检测安装时优先找的
 * 可执行名），`aliases` 是可执行文件的别名或包名尾段。
 *
 * 加一家要同时改四处，缺一处就会出现「列表里有、启动时不注入目录 / 读不了会话」：
 * - 本表（设置页的「系统支持」列表与安装检测）
 * - `lib/cli-launch.ts` 的 `ADDITIONAL_DIRS_SPECS`（附加目录怎么传）
 * - `lib/cli-sessions.ts` 的 `CLI_PROVIDERS`（会话历史怎么 resume）
 * - `src-tauri/src/installer.rs` 的 npm 白名单（想支持一键安装时）
 */
export interface AgentCatalogItem {
  /** 稳定标识，只在本表里用；状态检测的 key 由它派生 */
  key: string;
  name: string;
  /** 默认启动命令；可以带参数，检测安装时只看第一个词 */
  command: string;
  /** 可执行文件的其他叫法（Qoder 的 qodercli 这类） */
  aliases: string[];
  /** 一句话说明，展示在名字下面 */
  hint: string;
  /** 安装方式；没有可靠的一键安装命令时写官方渠道 */
  install: string;
}

/** 顺序就是设置页「系统支持」列表的顺序：常用 / 有会话历史的排前面 */
export const AGENT_CATALOG: AgentCatalogItem[] = [
  {
    key: "codebuddy",
    name: "CodeBuddy",
    command: "codebuddy",
    aliases: ["codebuddy-code"],
    hint: "腾讯 CodeBuddy Code，支持 --add-dir 注入工作区目录",
    install: "npm install -g @tencent-ai/codebuddy-code",
  },
  {
    key: "claude",
    name: "Claude Code",
    command: "claude",
    aliases: ["claude-code"],
    hint: "Anthropic 官方 CLI，支持 --add-dir 注入工作区目录",
    install: "npm install -g @anthropic-ai/claude-code",
  },
  {
    key: "codex",
    name: "Codex",
    // 和设置默认值保持一致：不带 --no-daemon 会另起常驻进程
    command: "codex --no-daemon",
    aliases: [],
    hint: "OpenAI Codex CLI，支持 --add-dir 注入工作区目录",
    install: "npm install -g @openai/codex",
  },
  {
    key: "qoder",
    name: "Qoder",
    command: "qodercli",
    aliases: ["qoder"],
    hint: "Qoder CLI，可执行文件叫 qodercli，支持 --add-dir",
    install: "Qoder 官方安装包",
  },
  {
    key: "opencode",
    name: "opencode",
    command: "opencode",
    aliases: [],
    hint: "通过 OPENCODE_CONFIG_CONTENT 注入工作区目录权限",
    install: "npm install -g @opencode/cli",
  },
  {
    key: "agy",
    name: "Antigravity",
    command: "agy",
    aliases: ["antigravity"],
    hint: "Google Antigravity CLI，可执行文件叫 agy",
    install: "Antigravity 官方安装包",
  },
  {
    key: "copilot",
    name: "GitHub Copilot",
    command: "copilot",
    aliases: [],
    hint: "GitHub Copilot CLI，支持 --add-dir= 注入工作区目录",
    install: "GitHub Copilot CLI 官方安装",
  },
  {
    key: "gemini",
    name: "Gemini CLI",
    command: "gemini",
    aliases: ["gemini-cli"],
    hint: "Google Gemini CLI，支持 --include-directories",
    install: "npm install -g @google/gemini-cli",
  },
  {
    key: "qwen",
    name: "Qwen Code",
    command: "qwen",
    aliases: ["qwen-code"],
    hint: "通义千问 Qwen Code，支持 --include-directories",
    install: "npm install -g @qwen-code/qwen-code",
  },
  {
    key: "iflow",
    name: "iFlow CLI",
    command: "iflow",
    aliases: ["iflow-cli"],
    hint: "心流 iFlow CLI，支持 --include-directories",
    install: "iFlow CLI 官方安装",
  },
];

/** 后端返回的检测结果；id 由前端定，原样带回 */
export interface AgentCliStatus {
  id: string;
  installed: boolean;
  version: string | null;
}

interface AgentCliQuery {
  id: string;
  /** 候选可执行名，按顺序试；带路径的会直接检查文件是否存在 */
  commands: string[];
}

/**
 * 批量检测本机是否装了这些 CLI。
 *
 * 只跑 `<可执行文件> --version`，不经过 shell；版本读不出来不影响「已安装」的判断
 * （有的 CLI 没有 --version）。
 */
export function checkAgentClis(queries: AgentCliQuery[]): Promise<AgentCliStatus[]> {
  return invoke<AgentCliStatus[]>("check_agent_clis", { queries });
}

/** 「系统支持」列表里某一项的检测结果 key */
export function catalogStatusId(key: string): string {
  return `catalog:${key}`;
}

/** 已配置条目按命令文本查状态；同一条命令配了两次就共用一份结果 */
export function commandStatusId(command: string): string {
  return `cmd:${command.trim().toLowerCase()}`;
}

/** 一条命令里出现的可执行名 / 包名，用来认「这条配置是不是某个 Agent」 */
function commandTokens(command: string): string[] {
  return command
    .toLowerCase()
    .split(/[\s/@\\]+/)
    .map((token) => token.replace(/\.(exe|cmd|bat|ps1)$/, ""))
    .filter((token) => token !== "");
}

/**
 * 已配置列表里是不是已经有这家 Agent：返回下标，没有返回 null。
 *
 * 命令可能写成 `npx -y @anthropic-ai/claude-code`，所以不只看首词——把整条命令
 * 拆成词再和可执行名 / 包名尾段比。名字不算，用户起的名字可以随便填。
 */
export function configuredIndex(item: AgentCatalogItem, commands: AiCommand[]): number | null {
  // 目录里的 command 可能带参数（codex --no-daemon），比对的是可执行名
  const executable = (item.command.trim().split(/\s+/)[0] ?? "")
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|ps1)$/, "");
  const names = [executable, ...item.aliases];
  const index = commands.findIndex((command) =>
    commandTokens(command.command).some((token) => names.includes(token)),
  );
  return index < 0 ? null : index;
}

/**
 * 某个启动命令该带哪些环境变量。
 *
 * resume 出来的命令是 `claude --resume <id>`，比配置里多一段参数，所以按前缀匹配；
 * 多条都能匹配时取第一条（配置顺序就是优先级）。
 */
export function agentEnvFor(
  commands: AiCommand[],
  command: string,
): Record<string, string> {
  const text = command.trim();
  const match = commands.find((item) => {
    const base = item.command.trim();
    return base !== "" && (text === base || text.startsWith(`${base} `));
  });
  if (!match) return {};

  const env: Record<string, string> = {};
  for (const entry of match.env) {
    const key = entry.key.trim();
    // 空键是界面里刚加还没填的行，跳过；同名后者覆盖前者
    if (key !== "") env[key] = entry.value;
  }
  return env;
}
