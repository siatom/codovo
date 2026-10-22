import { invoke } from "@tauri-apps/api/core";
import type { DbConnection } from "./database";

/**
 * 数据库 Agent 的哨兵 root。它不是工作区路径——后端据此把数据库 Agent 的 opencode
 * 进程与终端区智能体分开（cwd 落在应用配置目录下，见 src-tauri/src/agent.rs）。
 * 前端调 `agent_*` 那一组命令时统一用它。
 */
export const DB_AGENT_ROOT = "__db_agent__";

/**
 * 当前会话 id 存 sessionStorage：重启后还能接上。
 * **只存一条**——数据库 Agent 的历史是所有连接共用的一份（对话本身不绑定库，
 * 执行 SQL 时才用当前目标连接），所以不按连接分开记。
 */
const SESSION_KEY = "codovo.dbAgentSession";

export function readDbAgentSession(): string {
  try {
    return window.sessionStorage.getItem(SESSION_KEY) ?? "";
  } catch {
    return "";
  }
}

export function writeDbAgentSession(sessionId: string) {
  try {
    window.sessionStorage.setItem(SESSION_KEY, sessionId);
  } catch {
    // 记不住只影响下次打开时的还原
  }
}

/**
 * 把「Agent 面向哪个连接」同步给后端。MCP 工具进程是独立的，拿不到主进程的连接池，
 * 靠后端写下的 target.json（不含密码）得知该查哪个库。
 *
 * 没选连接时不动文件——保留上一次的目标，总比清空后让工具一律报错好。
 */
export function dbAgentSetTarget(connection: DbConnection | null): Promise<void> {
  if (!connection) return Promise.resolve();
  return invoke<void>("db_agent_set_target", {
    request: {
      connId: connection.id,
      kind: connection.kind,
      host: connection.host,
      port: connection.port,
      user: connection.user,
      database: connection.database,
      file: connection.file,
    },
  });
}
