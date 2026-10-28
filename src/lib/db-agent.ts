import { invoke } from "@tauri-apps/api/core";
import type { DbConnection } from "./database";

/**
 * 数据库 Agent 的哨兵 root。它不是工作区路径——后端据此给数据库助手单独一个槽位
 * （工作目录落在应用配置目录下，见 src-tauri/src/agent/mod.rs）。
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
 * 把「Agent 面向哪个连接」同步给后端。数据库工具和界面跑在同一个进程里，但工具拿不到
 * 前端的选中状态，所以由这里把连接信息（不含密码）写进后端的内存目标。
 *
 * 没选连接时不动——保留上一次的目标，总比清空后让工具一律报错好。
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
