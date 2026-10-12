import {
  emptyAgentLayer,
  type AgentLayer,
  type Settings,
} from "./settings";

/** 技能名 / agent 名的合法形态：和后端 validate_name、opencode 的技能名规则一致 */
const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * 内置「应用助手」primary agent 的名字与显示名。名字要和后端
 * `src-tauri/src/agent.rs` 的 `APP_AGENT_AGENT_NAME` 对齐——那边把它写进 opencode 的
 * agent map，这边只是选它。
 */
export const APP_AGENT_NAME = "app";
export const APP_AGENT_LABEL = "应用助手";

/**
 * 内置「预览助手」primary agent 的名字与显示名。名字要和后端
 * `src-tauri/src/agent.rs` 的 `PREVIEW_AGENT_AGENT_NAME` 对齐——那边把它写进 opencode 的
 * agent map，这边只是选它。
 */
export const PREVIEW_AGENT_NAME = "preview";
export const PREVIEW_AGENT_LABEL = "预览助手";

export function isValidAgentName(name: string): boolean {
  return NAME_PATTERN.test(name.trim());
}

/** 取某个工作区对应的配置层；没有记录或还没选工作区就返回空层 */
export function workspaceLayer(settings: Settings, cwd: string | null): AgentLayer {
  if (!cwd) return emptyAgentLayer();
  return settings.agentWorkspaces[cwd] ?? emptyAgentLayer();
}

/** 按 name 去重合并两份列表；后一份（工作区层）的同名项覆盖前一份 */
function mergeByName<T extends { name: string }>(base: T[], over: T[]): T[] {
  const merged = new Map<string, T>();
  for (const item of base) merged.set(item.name, item);
  for (const item of over) merged.set(item.name, item);
  return [...merged.values()];
}

/**
 * 把「全局 + 当前工作区」两层合并成生效层，交给后端物化。
 *
 * - 规则 / 记忆：两段文本都保留，全局在前、工作区在后，用空行隔开；
 * - 技能 / Agents：按名去重，工作区层覆盖全局层；
 * - 关掉的（enabled=false）和名字非法的条目在这里就滤掉——非法名会让后端的
 *   校验直接报错、把整个服务拦下，不如提前丢。
 */
export function resolveAgentLayer(settings: Settings, cwd: string | null): AgentLayer {
  const global = settings.agentGlobal;
  const workspace = workspaceLayer(settings, cwd);

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

/** 对话面板选择器的 primary agent 候选：内置 build / plan / 应用助手 + 生效层里的 primary / all */
export function primaryAgentOptions(layer: AgentLayer): { value: string; label: string }[] {
  const custom = layer.agents
    .filter((agent) => agent.mode === "primary" || agent.mode === "all")
    .map((agent) => ({ value: agent.name, label: agent.name }));
  return [
    { value: "build", label: "build" },
    { value: "plan", label: "plan" },
    // 应用助手 / 预览助手由后端无条件注入到工作区智能体的配置里（见 agent.rs 的 write_config），
    // 所以它们总在候选里；选中只是把 primary 切成对应名字
    { value: APP_AGENT_NAME, label: APP_AGENT_LABEL },
    { value: PREVIEW_AGENT_NAME, label: PREVIEW_AGENT_LABEL },
    ...custom,
  ];
}

/** 写回一层配置：scope 决定改全局层还是当前工作区的层，返回可直接 update 的补丁 */
export function withLayer(
  settings: Settings,
  scope: "global" | "workspace",
  cwd: string | null,
  layer: AgentLayer,
): Partial<Settings> {
  if (scope === "global") return { agentGlobal: layer };
  if (!cwd) return {};
  return { agentWorkspaces: { ...settings.agentWorkspaces, [cwd]: layer } };
}
