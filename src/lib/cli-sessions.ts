import { invoke } from "@tauri-apps/api/core";
import type { CliSessionInfo } from "./types";

/**
 * 能列会话历史的 AI CLI。加新的一家要同时改后端 `src-tauri/src/cli_sessions.rs`：
 * jsonl 那两家加进 `provider_projects_dir`，其它形式的另开一支。
 */
export interface CliProvider {
  key: string;
  label: string;
  /** resume 时接在命令后的子命令/参数。opencode 是 --session，Codex 是 resume */
  resumeFlag: string;
}

/** 顺序就是侧边栏选择器里的显示顺序 */
export const CLI_PROVIDERS: CliProvider[] = [
  { key: "codebuddy", label: "CodeBuddy", resumeFlag: "--resume" },
  { key: "claude", label: "Claude Code", resumeFlag: "--resume" },
  { key: "codex", label: "Codex", resumeFlag: "resume" },
  { key: "opencode", label: "opencode", resumeFlag: "--session" },
];

const CLI_CHOICE_KEY = "codovo.cliChoice";

/**
 * 从一段文本里认 CLI 名：取第一个词（可执行文件名），去掉目录前缀和 Windows
 * 上常见的 .exe / .cmd 垫片后缀。
 *
 * 和 components/icons.tsx 里认 logo 的 `agentKey` 是同一套规则，故意留了两份：
 * 本仓库没有 lib 反向 import components 的先例，为一个五行的字符串函数破这个
 * 方向不划算。改后缀正则时两处一起改。`cli-launch.ts` 直接复用本函数，别再抄第三份。
 */
export function cliKey(text: string): string {
  const first = text.trim().split(/\s+/)[0] ?? "";
  const base = first.split(/[\\/]/).pop() ?? "";
  return base.replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
}

/**
 * 认出用户配置的这条命令是哪家 CLI。
 *
 * 逐个词过一遍而不是只看第一个：`npx codebuddy` 的首词是 "npx"，只看首词就
 * 认不出来了。名字也算一份——命令可以随便填，名字是用户自己起的。
 *
 * 认不出来（比如 `npx -y @anthropic-ai/claude-code` 这种包名形式）返回 null，
 * 界面据此显示"这家读不了会话历史"。
 */
export function cliProvider(command: string, name = ""): CliProvider | null {
  const words = [...command.trim().split(/\s+/), name.trim()].map(cliKey);
  return CLI_PROVIDERS.find((item) => words.includes(item.key)) ?? null;
}

/**
 * 拼 resume 命令。flag 由 provider 决定：codebuddy / claude 是 `--resume`，
 * opencode 是 `--session`（`opencode --help` 确认过，它没有 --resume）。
 *
 * 会话 id 是 UUID 或 `ses_xxx`，都不含分隔符和空格，所以拼进 zsh / pwsh / cmd
 * 都不需要转义。用户填的命令本身可能是 `npx codebuddy` 这种带空格的，直接接在
 * 后面即可。
 */
export function resumeCommand(
  command: string,
  sessionId: string,
  provider: CliProvider,
): string {
  return `${command} ${provider.resumeFlag} ${sessionId}`;
}

/** `command` 只有 opencode 用得上：它的记录得靠 opencode 自己来读 */
export function listCliSessions(
  provider: string,
  cwd: string,
  command: string,
): Promise<CliSessionInfo[]> {
  return invoke<CliSessionInfo[]>("cli_list_sessions", { provider, cwd, command });
}

/** 工作区路径 -> 用户上次在这个工作区里选的命令行。只认非空字符串，读坏了当没存过 */
function readCliChoices(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(CLI_CHOICE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const choices: Record<string, string> = {};
    for (const [path, command] of Object.entries(parsed)) {
      if (typeof command === "string" && command.trim()) choices[path] = command;
    }
    return choices;
  } catch {
    return {};
  }
}

/** 没选过时返回空串，由调用处回落到第一条命令 */
export function readCliChoice(cwd: string | null): string {
  if (!cwd) return "";
  return readCliChoices()[cwd] ?? "";
}

export function saveCliChoice(cwd: string | null, command: string) {
  if (!cwd) return;
  const next = readCliChoices();
  if (command.trim()) next[cwd] = command;
  else delete next[cwd];
  try {
    window.localStorage.setItem(CLI_CHOICE_KEY, JSON.stringify(next));
  } catch {
    // 写不进去只影响下次启动，本次会话照常生效
  }
}
