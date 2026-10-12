import { invoke } from "@tauri-apps/api/core";
import { emptyAgentLayer, type AgentLayer } from "./settings";

/** 一个项目层是不是全空（用来判断要不要做一次性迁移） */
export function isLayerEmpty(layer: AgentLayer): boolean {
  return (
    !layer.rules.trim() &&
    !layer.memory.trim() &&
    layer.skills.length === 0 &&
    layer.agents.length === 0
  );
}

/** 读工作区根的 `.codedock/` 项目层配置。文件不存在返回空层。 */
export function readWorkspaceLayerFile(root: string): Promise<AgentLayer> {
  return invoke<AgentLayer>("agent_config_read", { root });
}

/** 把项目层配置写到工作区根的 `.codedock/`。 */
export function writeWorkspaceLayerFile(root: string, layer: AgentLayer): Promise<void> {
  return invoke<void>("agent_config_write", { root, layer });
}

/**
 * 读项目层，并做一次性迁移：`.codedock/` 为空而 localStorage 里还留着旧的
 * `agentWorkspaces[root]` 时，把旧值写进文件（配置不丢），返回 `migrated: true`。
 * 之后文件非空，不会再迁移。
 */
export async function readWorkspaceLayer(
  root: string,
  legacy: AgentLayer | null | undefined,
): Promise<{ layer: AgentLayer; migrated: boolean }> {
  const fromFile = await readWorkspaceLayerFile(root);
  if (!isLayerEmpty(fromFile)) return { layer: fromFile, migrated: false };
  if (legacy && !isLayerEmpty(legacy)) {
    try {
      await writeWorkspaceLayerFile(root, legacy);
      return { layer: legacy, migrated: true };
    } catch {
      // 写不进去（例如只读目录）就退回旧值，至少不影响本次生效
      return { layer: legacy, migrated: false };
    }
  }
  return { layer: emptyAgentLayer(), migrated: false };
}
