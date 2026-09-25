import {
  emptyAgentLayer,
  type AgentLayer,
  type Settings,
} from "./settings";

/** 技能名 / agent 名的合法形态：和后端 validate_name、opencode 的技能名规则一致 */
const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function isValidAgentName(name: string): boolean {
  return NAME_PATTERN.test(name.trim());
}

/** 取某个工作区的项目层；没有记录或还没选工作区就返回空层 */
export function projectLayer(settings: Settings, cwd: string | null): AgentLayer {
  if (!cwd) return emptyAgentLayer();
  return settings.agentProjects[cwd] ?? emptyAgentLayer();
}

/** 按 name 去重合并两份列表；后一份（项目层）的同名项覆盖前一份 */
function mergeByName<T extends { name: string }>(base: T[], over: T[]): T[] {
  const merged = new Map<string, T>();
  for (const item of base) merged.set(item.name, item);
  for (const item of over) merged.set(item.name, item);
  return [...merged.values()];
}

/**
 * 把「全局 + 当前项目」两层合并成生效层，交给后端物化。
 *
 * - 规则 / 记忆：两段文本都保留，全局在前、项目在后，用空行隔开；
 * - 技能 / Agents：按名去重，项目层覆盖全局层；
 * - 关掉的（enabled=false）和名字非法的条目在这里就滤掉——非法名会让后端的
 *   校验直接报错、把整个服务拦下，不如提前丢。
 */
export function resolveAgentLayer(settings: Settings, cwd: string | null): AgentLayer {
  const global = settings.agentGlobal;
  const project = projectLayer(settings, cwd);

  const join = (a: string, b: string) =>
    [a, b].map((text) => text.trim()).filter(Boolean).join("\n\n");

  return {
    rules: join(global.rules, project.rules),
    memory: join(global.memory, project.memory),
    skills: mergeByName(global.skills, project.skills).filter(
      (skill) => skill.enabled && isValidAgentName(skill.name),
    ),
    agents: mergeByName(global.agents, project.agents).filter(
      (agent) => agent.enabled && isValidAgentName(agent.name),
    ),
  };
}

/** 对话面板选择器的 primary agent 候选：内置 build / plan + 生效层里的 primary / all */
export function primaryAgentOptions(layer: AgentLayer): { value: string; label: string }[] {
  const custom = layer.agents
    .filter((agent) => agent.mode === "primary" || agent.mode === "all")
    .map((agent) => ({ value: agent.name, label: agent.name }));
  return [
    { value: "build", label: "build" },
    { value: "plan", label: "plan" },
    ...custom,
  ];
}

/** 写回一层配置：scope 决定改全局层还是当前项目的层，返回可直接 update 的补丁 */
export function withLayer(
  settings: Settings,
  scope: "global" | "project",
  cwd: string | null,
  layer: AgentLayer,
): Partial<Settings> {
  if (scope === "global") return { agentGlobal: layer };
  if (!cwd) return {};
  return { agentProjects: { ...settings.agentProjects, [cwd]: layer } };
}
