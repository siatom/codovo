import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

/** 自动保存时机，四种跟 VS Code 的 files.autoSave 对齐 */
export type AutoSaveMode = "off" | "afterDelay" | "onFocusChange" | "onWindowChange";

export interface AiCommand {
  name: string;
  command: string;
}

/** 一条可复用的技能：物化成一份 SKILL.md，Agent 按需加载 */
export interface AgentSkill {
  name: string;
  description: string;
  content: string;
  enabled: boolean;
}

/** 一个自定义 agent；primary 能在对话面板里切换，subagent 由主 agent 调用 */
export interface AgentProfile {
  name: string;
  description: string;
  mode: "primary" | "subagent" | "all";
  /** 留空表示用全局默认模型 */
  model: string;
  prompt: string;
  enabled: boolean;
}

/** 一层智能体配置：规则 + 记忆 + 技能 + Agents。全局一层，每个工作区各一层 */
export interface AgentLayer {
  rules: string;
  memory: string;
  skills: AgentSkill[];
  agents: AgentProfile[];
}

export interface Settings {
  /** 终端工具条上 AI CLI 按钮可选的配置；多于一个时点按钮给下拉选择 */
  aiCommands: AiCommand[];
  /** AI 生成提交信息：OpenAI 兼容接口的基地址，如 https://api.deepseek.com/v1 */
  aiBaseUrl: string;
  /** AI 生成提交信息用的模型名，如 deepseek-chat */
  aiModel: string;
  /** AI 接口密钥；明文存 localStorage，与其余设置一致 */
  aiApiKey: string;
  /** 终端区是否出现「终端 / 智能体」切换；关掉就和以前一样只有终端 */
  agentEnabled: boolean;
  /** opencode 可执行文件；裸命令名会去 PATH 里找 */
  agentCommand: string;
  /** 智能体服务监听的端口；0 表示自动挑一个空闲的 */
  agentPort: number;
  /** 对话面板里选中的 primary agent；空或不存在时由 opencode 回落到 build */
  agentPrimary: string;
  /** 全局层的智能体配置（所有项目共享） */
  agentGlobal: AgentLayer;
  /** 项目层的智能体配置，按工作区绝对路径索引 */
  agentProjects: Record<string, AgentLayer>;
  /** 终端启动的 shell 候选 id；空串表示自动（后端按平台挑） */
  terminalShell: string;
  /** 终端字体（CSS font-family），留空用默认 */
  terminalFontFamily: string;
  /** 终端字号（px） */
  terminalFontSize: number;
  /** 终端字体是否加粗 */
  terminalFontBold: boolean;
  /** 终端配色主题，取 xterm-theme 的导出名；空串表示跟随界面深/浅色 */
  terminalTheme: string;
  /** 编辑器字体（CSS font-family），留空用默认 */
  editorFontFamily: string;
  /** 编辑器字号（px） */
  editorFontSize: number;
  /** 编辑器字体是否加粗 */
  editorFontBold: boolean;
  /** 编辑器自动保存时机 */
  editorAutoSave: AutoSaveMode;
  /** afterDelay 模式下停手多久才落盘（毫秒） */
  editorAutoSaveDelay: number;
  /** 右边栏的各个模块：关掉哪个，图标条上就不出哪个入口 */
  rightFilesVisible: boolean;
  rightChangesVisible: boolean;
  rightSearchVisible: boolean;
  rightBrowserVisible: boolean;
}

const SETTINGS_KEY = "codedock.settings";

export const FONT_SIZE_MIN = 11;
export const FONT_SIZE_MAX = 20;
export const AUTOSAVE_DELAY_MIN = 300;
export const AUTOSAVE_DELAY_MAX = 10000;

const AUTO_SAVE_MODES: AutoSaveMode[] = [
  "off",
  "afterDelay",
  "onFocusChange",
  "onWindowChange",
];

/** 默认等宽字体栈：终端和编辑器共用，两处都留空时看到的还是同一个字体 */
export const DEFAULT_MONO_FONT =
  '"Cascadia Mono", Consolas, "JetBrains Mono", Menlo, monospace';

/** 字体名留空就回落默认栈，界面上允许清空、不至于把字体搞没 */
export function resolveFont(value: string): string {
  return value.trim() || DEFAULT_MONO_FONT;
}

/** 智能体的 mode 取值；和 opencode 的 AgentConfig.mode 对齐 */
const AGENT_MODES: AgentProfile["mode"][] = ["primary", "subagent", "all"];

/** 新的一层空配置。工厂而不是常量：多处会各自持有、不能被共享引用串改 */
export function emptyAgentLayer(): AgentLayer {
  return { rules: "", memory: "", skills: [], agents: [] };
}

const DEFAULTS: Settings = {
  aiCommands: [
    { name: "claude", command: "claude" },
    { name: "codebuddy", command: "codebuddy" },
    { name: "opencode", command: "opencode" },
  ],
  // 接口地址和模型留空：不预置某一家厂商，让用户自己填
  aiBaseUrl: "",
  aiModel: "",
  aiApiKey: "",
  agentEnabled: true,
  agentCommand: "opencode",
  agentPort: 0,
  agentPrimary: "build",
  agentGlobal: emptyAgentLayer(),
  agentProjects: {},
  terminalShell: "",
  terminalFontFamily: "",
  terminalFontSize: 13,
  terminalFontBold: true,
  terminalTheme: "",
  editorFontFamily: "",
  editorFontSize: 13,
  editorFontBold: true,
  editorAutoSave: "afterDelay",
  editorAutoSaveDelay: 1000,
  rightFilesVisible: true,
  rightChangesVisible: true,
  rightSearchVisible: true,
  rightBrowserVisible: true,
};

function clampSize(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(value)));
}

function clampDelay(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(AUTOSAVE_DELAY_MAX, Math.max(AUTOSAVE_DELAY_MIN, Math.round(value)));
}

/** 端口；0 是合法的（表示自动分配） */
function clampPort(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(65535, Math.max(0, Math.round(value)));
}

/** 存的是字符串，但值域是固定的四个；读坏了回落默认 */
function asAutoSave(value: unknown): AutoSaveMode {
  return AUTO_SAVE_MODES.includes(value as AutoSaveMode)
    ? (value as AutoSaveMode)
    : DEFAULTS.editorAutoSave;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asCommandList(value: unknown): AiCommand[] {
  if (!Array.isArray(value)) return [...DEFAULTS.aiCommands];
  return value.flatMap((item): AiCommand[] => {
    if (typeof item === "string") return [{ name: item, command: item }];
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (typeof record.name !== "string" || typeof record.command !== "string") return [];
    return [{ name: record.name, command: record.command }];
  });
}

function asAgentMode(value: unknown): AgentProfile["mode"] {
  return AGENT_MODES.includes(value as AgentProfile["mode"])
    ? (value as AgentProfile["mode"])
    : "subagent";
}

/** 逐条校验技能：名字和描述是 opencode 认的必填项，缺了就丢掉这条 */
function asSkillList(value: unknown): AgentSkill[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): AgentSkill[] => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (typeof record.name !== "string" || typeof record.description !== "string") return [];
    return [
      {
        name: record.name,
        description: record.description,
        content: asString(record.content, ""),
        enabled: asBoolean(record.enabled, true),
      },
    ];
  });
}

function asAgentList(value: unknown): AgentProfile[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): AgentProfile[] => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (typeof record.name !== "string" || typeof record.description !== "string") return [];
    return [
      {
        name: record.name,
        description: record.description,
        mode: asAgentMode(record.mode),
        model: asString(record.model, ""),
        prompt: asString(record.prompt, ""),
        enabled: asBoolean(record.enabled, true),
      },
    ];
  });
}

function asLayer(value: unknown): AgentLayer {
  if (!value || typeof value !== "object") return emptyAgentLayer();
  const record = value as Record<string, unknown>;
  return {
    rules: asString(record.rules, ""),
    memory: asString(record.memory, ""),
    skills: asSkillList(record.skills),
    agents: asAgentList(record.agents),
  };
}

/** 项目层是按工作区路径索引的一张表，逐项校验；读坏的条目直接丢掉 */
function asProjectLayers(value: unknown): Record<string, AgentLayer> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, AgentLayer> = {};
  for (const [key, layer] of Object.entries(value as Record<string, unknown>)) {
    out[key] = asLayer(layer);
  }
  return out;
}

/** 存的是一整块 JSON：读坏了就当没存过，回落默认值，不让界面起不来 */
function readSaved(): Settings {
  let raw: Record<string, unknown> = {};
  try {
    const text = window.localStorage.getItem(SETTINGS_KEY);
    if (text) raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    raw = {};
  }

  const aiCommands = asCommandList(raw.aiCommands);

  return {
    aiCommands,
    aiBaseUrl: asString(raw.aiBaseUrl, DEFAULTS.aiBaseUrl),
    aiModel: asString(raw.aiModel, DEFAULTS.aiModel),
    aiApiKey: asString(raw.aiApiKey, DEFAULTS.aiApiKey),
    // 老版本的设置里没有这三个字段，asBoolean 回落 true 就是默认开着
    agentEnabled: asBoolean(raw.agentEnabled, DEFAULTS.agentEnabled),
    agentCommand: asString(raw.agentCommand, DEFAULTS.agentCommand),
    agentPort: clampPort(raw.agentPort, DEFAULTS.agentPort),
    agentPrimary: asString(raw.agentPrimary, DEFAULTS.agentPrimary),
    // 老版本的设置里没有这两项，回落成空层 / 空表
    agentGlobal: asLayer(raw.agentGlobal),
    agentProjects: asProjectLayers(raw.agentProjects),
    terminalShell: asString(raw.terminalShell, DEFAULTS.terminalShell),
    terminalFontFamily: asString(raw.terminalFontFamily, DEFAULTS.terminalFontFamily),
    terminalFontSize: clampSize(raw.terminalFontSize, DEFAULTS.terminalFontSize),
    terminalFontBold: asBoolean(raw.terminalFontBold, DEFAULTS.terminalFontBold),
    terminalTheme: asString(raw.terminalTheme, DEFAULTS.terminalTheme),
    editorFontFamily: asString(raw.editorFontFamily, DEFAULTS.editorFontFamily),
    editorFontSize: clampSize(raw.editorFontSize, DEFAULTS.editorFontSize),
    editorFontBold: asBoolean(raw.editorFontBold, DEFAULTS.editorFontBold),
    editorAutoSave: asAutoSave(raw.editorAutoSave),
    editorAutoSaveDelay: clampDelay(
      raw.editorAutoSaveDelay,
      DEFAULTS.editorAutoSaveDelay,
    ),
    // 老版本的设置里没有这几个字段，asBoolean 会回落到 true，也就是默认全展示
    rightFilesVisible: asBoolean(raw.rightFilesVisible, DEFAULTS.rightFilesVisible),
    rightChangesVisible: asBoolean(
      raw.rightChangesVisible,
      DEFAULTS.rightChangesVisible,
    ),
    rightSearchVisible: asBoolean(
      raw.rightSearchVisible,
      DEFAULTS.rightSearchVisible,
    ),
    rightBrowserVisible: asBoolean(
      raw.rightBrowserVisible,
      DEFAULTS.rightBrowserVisible,
    ),
  };
}

interface SettingsValue {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  /** 整块回到出厂默认，设置面板上的每一项都算在内 */
  reset: () => void;
}

const SettingsContext = createContext<SettingsValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(readSaved);

  useEffect(() => {
    try {
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // 写不进去只影响下次启动，本次会话照常生效
    }
  }, [settings]);

  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((current) => ({ ...current, ...patch }));
  }, []);

  // aiCommands 要拷一份：DEFAULTS 是模块级常量，直接把它的数组当成实时状态挂上去，
  // 哪天有人在原地改这个数组，默认值就跟着被改掉了
  const reset = useCallback(() => {
    setSettings({
      ...DEFAULTS,
      aiCommands: DEFAULTS.aiCommands.map((item) => ({ ...item })),
      // 同 aiCommands：DEFAULTS 是模块级常量，层里带数组，必须换成新对象
      agentGlobal: emptyAgentLayer(),
      agentProjects: {},
    });
  }, []);

  return (
    <SettingsContext.Provider value={{ settings, update, reset }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings(): SettingsValue {
  const value = useContext(SettingsContext);
  if (!value) throw new Error("useSettings 必须在 SettingsProvider 内使用");
  return value;
}
