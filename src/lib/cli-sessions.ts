import { invoke } from "@tauri-apps/api/core";
import type { AiCommand } from "./settings";
import type { CliSessionInfo } from "./types";

/**
 * 能列会话历史的 AI CLI。加新的一家要同时改后端 `src-tauri/src/cli_sessions.rs`：
 * 写 jsonl 的那几家加进 `provider_projects_dir`，其它形式的另开一支。
 */
export interface CliProvider {
  key: string;
  label: string;
  /** resume 时接在命令后的子命令/参数。opencode 是 --session，Codex 是 resume */
  resumeFlag: string;
  /**
   * 设置里没配过这家命令时，resume 直接用的可执行文件名。Qoder CLI 的 key 是
   * qoder，可执行文件却叫 qodercli，两者不能混用
   */
  bin: string;
  /**
   * 可执行文件名和 key 不一致时的别名。Qoder CLI 的 key 是 qoder，
   * 但可执行文件叫 qodercli，只比 key 会认不出来
   */
  aliases?: string[];
}

/** 顺序就是合并列表里同时间会话的兜底顺序 */
export const CLI_PROVIDERS: CliProvider[] = [
  { key: "codebuddy", label: "CodeBuddy", resumeFlag: "--resume", bin: "codebuddy" },
  { key: "claude", label: "Claude Code", resumeFlag: "--resume", bin: "claude" },
  { key: "codex", label: "Codex", resumeFlag: "resume", bin: "codex" },
  {
    key: "qoder",
    label: "Qoder",
    resumeFlag: "--resume",
    bin: "qodercli",
    aliases: ["qodercli"],
  },
  { key: "opencode", label: "opencode", resumeFlag: "--session", bin: "opencode" },
];

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
  return (
    CLI_PROVIDERS.find((item) =>
      [item.key, ...(item.aliases ?? [])].some((key) => words.includes(key)),
    ) ?? null
  );
}

/**
 * 拼 resume 命令。flag 由 provider 决定：codebuddy / claude / qoder 是 `--resume`，
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
function listCliSessions(
  provider: string,
  cwd: string,
  command: string,
): Promise<CliSessionInfo[]> {
  return invoke<CliSessionInfo[]>("cli_list_sessions", { provider, cwd, command });
}

/** 侧栏里一条对话：会话本身 + 它是哪家 CLI 的、点开怎么 resume */
export interface CliHistoryEntry extends CliSessionInfo {
  /** CLI_PROVIDERS 里的 key */
  provider: string;
  /** 展示用的 CLI 名（CodeBuddy / Claude Code …） */
  label: string;
  /** 已经接上会话 id 的完整 resume 命令 */
  resume: string;
}

/** 合并后最多给多少条。侧栏一屏放得下二十来条，再多只会把别的工作区挤到很远 */
const HISTORY_LIMIT = 20;

/**
 * 一个工作区下所有 AI CLI 的对话，按最后活动时间倒序合并成一条列表。
 *
 * 记录是各家 CLI 自己写在磁盘上的，所以不要求用户在 Codovo 里配过这家才看得见历史；
 * resume 时优先用设置里配的命令，没配过就退回可执行文件名（见 CliProvider.bin）。
 *
 * 单个 CLI / 单个根读失败（没装、服务没起、记录格式变了）只当它没有记录：侧栏是看
 * 状态的地方，一家的错不该把整块列表变成报错面板。
 */
export async function listWorkspaceHistory(
  roots: string[],
  commands: AiCommand[],
): Promise<CliHistoryEntry[]> {
  const jobs: Promise<CliHistoryEntry[]>[] = [];
  for (const provider of CLI_PROVIDERS) {
    const configured = commands.find(
      (item) => cliProvider(item.command, item.name)?.key === provider.key,
    );
    const command = configured?.command.trim() || provider.bin;
    for (const root of roots) {
      jobs.push(
        listCliSessions(provider.key, root, command)
          .then((list) =>
            list.map((item) => ({
              ...item,
              provider: provider.key,
              label: provider.label,
              resume: resumeCommand(command, item.id, provider),
            })),
          )
          .catch(() => []),
      );
    }
  }
  const merged = (await Promise.all(jobs)).flat();
  merged.sort((a, b) => b.updated - a.updated || a.id.localeCompare(b.id));
  return merged.slice(0, HISTORY_LIMIT);
}
