import type { AgentLayer } from "./settings";

/** 技能名 / agent 名的合法形态：和后端 config.rs 的校验、内置技能命名一致 */
const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * 内置「应用助手」agent 的名字与显示名。名字要和后端
 * `src-tauri/src/agent/prompt.rs` 的 `Kind::App` 对齐——那边按它去用户的 agent 列表里找
 * 自定义提示词。前端只用它找用户给这个 agent 绑的模型。
 */
export const APP_AGENT_NAME = "app";
export const APP_AGENT_LABEL = "应用助手";

/**
 * 内置「预览助手」agent 的名字与显示名。名字要和后端 `Kind::Preview` 对齐。
 * 前端不拿名字去选，只留 `PREVIEW_AGENT_LABEL` 给面板显示。
 */
export const PREVIEW_AGENT_NAME = "preview";
export const PREVIEW_AGENT_LABEL = "预览助手";

export function isValidAgentName(name: string): boolean {
  return NAME_PATTERN.test(name.trim());
}

/** 按 name 去重合并两份列表；后一份（项目层）的同名项覆盖前一份 */
function mergeByName<T extends { name: string }>(base: T[], over: T[]): T[] {
  const merged = new Map<string, T>();
  for (const item of base) merged.set(item.name, item);
  for (const item of over) merged.set(item.name, item);
  return [...merged.values()];
}

/**
 * 把「全局 + 项目」两层合并成生效层，交给后端物化。
 *
 * - 规则 / 记忆：两段文本都保留，全局在前、项目在后，用空行隔开；
 * - 技能 / Agents：按名去重，项目层覆盖全局层；
 * - 关掉的（enabled=false）和名字非法的条目在这里就滤掉——非法名会让后端的
 *   校验直接报错、把整个服务拦下，不如提前丢。
 */
export function mergeAgentLayer(global: AgentLayer, workspace: AgentLayer): AgentLayer {
  const join = (a: string, b: string) =>
    [a, b].map((text) => text.trim()).filter(Boolean).join("\n\n");

  return {
    rules: join(global.rules, workspace.rules),
    memory: join(global.memory, workspace.memory),
    skills: mergeByName(global.skills, workspace.skills).filter(
      (skill) => skill.enabled && isValidAgentName(skill.name),
    ),
    agents: mergeByName(global.agents, workspace.agents).filter(
      (agent) => agent.enabled && isValidAgentName(agent.name),
    ),
  };
}
