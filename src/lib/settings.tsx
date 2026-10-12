import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { secretStatus, setSecret } from "./secrets";
import { defaultShortcuts, resolveShortcuts } from "./shortcuts";

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

/** 提供商下的一个模型；id 就是接口认的模型名 */
export interface ProviderModel {
  id: string;
  /** 显示名，界面上留空就回落到 id */
  name: string;
  enabled: boolean;
}

/**
 * 一个 LLM 提供商。本次只支持 OpenAI 兼容协议，所以没有协议字段——
 * 换协议意味着换 AI SDK 包，不是加个下拉能兜住的，等真做时再加。
 *
 * `id` 一旦生成就不再变（改名也不变）：它同时是 opencode 的 provider key、
 * 模型引用的前缀（`provider/model`）和密钥环境变量名的来源。
 */
export interface AiProvider {
  id: string;
  name: string;
  /** OpenAI 兼容基地址，结尾带不带 `/` 都行 */
  baseUrl: string;
  /** 密钥是否已存进系统钥匙串。明文永远不会落在这个字段上 */
  apiKeySet: boolean;
  /**
   * 待搬迁的明文密钥。**只在一种情况下有值**：旧版本把明文存在 localStorage 里，
   * 而这次启动还没把它写进系统钥匙串。
   *
   * 搬迁成功立刻抹掉；失败就原样留着（下次启动重试），绝不主动丢掉用户填过的密钥。
   * 新数据不会有这个字段。
   */
  apiKey?: string;
  models: ProviderModel[];
  enabled: boolean;
}

export interface Settings {
  /** 终端工具条上 AI CLI 按钮可选的配置；多于一个时点按钮给下拉选择 */
  aiCommands: AiCommand[];
  /** LLM 提供商列表，智能体与 AI 生成提交信息共用 */
  aiProviders: AiProvider[];
  /** 全局默认模型所在的提供商 id；空或失效时回落到第一个启用项 */
  aiDefaultProvider: string;
  /** 全局默认模型 id；空或失效时回落到该提供商的第一个启用模型 */
  aiDefaultModel: string;
  /** 终端区是否出现「终端 / 智能体」切换；关掉就和以前一样只有终端 */
  agentEnabled: boolean;
  /** opencode 可执行文件；裸命令名会去 PATH 里找 */
  agentCommand: string;
  /** 智能体服务监听的端口；0 表示自动挑一个空闲的 */
  agentPort: number;
  /** 对话面板里选中的 primary agent；空或不存在时由 opencode 回落到 build */
  agentPrimary: string;
  /** 全局层的智能体配置（所有工作区共享） */
  agentGlobal: AgentLayer;
  /**
   * @deprecated 工作区层的智能体配置已改以工作区根下 `.codedock/` 的文件为准，
   * 这里只保留旧数据用于一次性迁移（见 lib/agent-config.ts 的 readWorkspaceLayer）
   * 以及删除提供商时对遗留引用的粗略计数。新代码不要再读写它。
   */
  agentWorkspaces: Record<string, AgentLayer>;
  /** 界面字体（CSS font-family），留空用默认无衬线栈；只作用于界面，终端与编辑器各自另设 */
  uiFontFamily: string;
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
  /**
   * 终端里 AI CLI 停在需要用户输入的提示上时，在标签与侧栏标出来。
   * 判据是备用屏上的输出特征，属于启发式、可能误报，所以留个开关。
   */
  terminalWaitHint: boolean;
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
  /**
   * 关窗口时直接收进托盘、不再问。开着工作区才用得着——没工作区时关闭就是退出。
   * 用户在某次确认框里勾了「不再提醒」就会置成 true
   */
  closeToTray: boolean;
  /** 右边栏的各个模块：关掉哪个，图标条上就不出哪个入口 */
  rightFilesVisible: boolean;
  rightChangesVisible: boolean;
  rightSearchVisible: boolean;
  rightBrowserVisible: boolean;
  rightRemoteVisible: boolean;
  rightDatabaseVisible: boolean;
  rightPreviewVisible: boolean;
  /** 应用命令的键位，按命令 id 索引；值的写法见 lib/shortcuts.ts */
  shortcuts: Record<string, string>;
}

const SETTINGS_KEY = "codedock.settings";

/**
 * 设置面板上可单独恢复默认的分类，和 SettingsDialog 的 tab 一一对应。
 * `dependencies` 只有环境检测与安装、没有设置项，所以不在这里。
 */
export type SettingsSection = "appearance" | "terminal" | "editor" | "shortcuts" | "agent";

/**
 * 每个分类各管哪些字段。恢复某一页默认时只把这些键写回出厂值，别的分类原样留着。
 * 新增设置项时把它加进对应分类，否则「恢复本页默认」会漏掉它。
 *
 * 注意 `appearance` 里的主题不在 Settings 上（在 theme.tsx），由设置面板另外处理。
 */
const SECTION_KEYS: Record<SettingsSection, (keyof Settings)[]> = {
  appearance: [
    "agentEnabled",
    "uiFontFamily",
    "rightFilesVisible",
    "rightChangesVisible",
    "rightSearchVisible",
    "rightBrowserVisible",
    "rightRemoteVisible",
    "rightDatabaseVisible",
    "rightPreviewVisible",
    "closeToTray",
  ],
  terminal: [
    "terminalShell",
    "terminalTheme",
    "terminalFontFamily",
    "terminalFontSize",
    "terminalFontBold",
    "terminalWaitHint",
    "aiCommands",
  ],
  editor: [
    "editorFontFamily",
    "editorFontSize",
    "editorFontBold",
    "editorAutoSave",
    "editorAutoSaveDelay",
  ],
  shortcuts: ["shortcuts"],
  agent: [
    "aiProviders",
    "aiDefaultProvider",
    "aiDefaultModel",
    "agentCommand",
    "agentPort",
    "agentPrimary",
    "agentGlobal",
    "agentWorkspaces",
  ],
};

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

/** 界面默认字体栈：无衬线，跟 styles.css 里 body 的兜底保持一致 */
export const DEFAULT_UI_FONT =
  'ui-sans-serif, system-ui, "Segoe UI", "Microsoft YaHei", sans-serif';

/** 界面字体名留空就回落默认无衬线栈 */
export function resolveUiFont(value: string): string {
  return value.trim() || DEFAULT_UI_FONT;
}

/** 智能体的 mode 取值；和 opencode 的 AgentConfig.mode 对齐 */
const AGENT_MODES: AgentProfile["mode"][] = ["primary", "subagent", "all"];

/** 新的一层空配置。工厂而不是常量：多处会各自持有、不能被共享引用串改 */
export function emptyAgentLayer(): AgentLayer {
  return { rules: "", memory: "", skills: [], agents: [] };
}

const DEFAULTS: Settings = {
  // name 用各家的规范写法（与 lib/cli-sessions.ts 的 CLI_PROVIDERS.label 对齐），
  // command 才是实际会跑的可执行文件名
  aiCommands: [
    { name: "Claude Code", command: "claude" },
    { name: "Codex", command: "codex --no-daemon" },
    { name: "Antigravity", command: "agy" },
    { name: "CodeBuddy", command: "codebuddy" },
    { name: "opencode", command: "opencode" },
  ],
  // 不预置任何厂商：提供商和模型都由用户自己加
  aiProviders: [],
  aiDefaultProvider: "",
  aiDefaultModel: "",
  agentEnabled: true,
  agentCommand: "opencode",
  agentPort: 0,
  agentPrimary: "build",
  agentGlobal: emptyAgentLayer(),
  agentWorkspaces: {},
  uiFontFamily: "",
  terminalShell: "",
  terminalFontFamily: "",
  terminalFontSize: 13,
  terminalFontBold: true,
  terminalTheme: "",
  terminalWaitHint: true,
  editorFontFamily: "",
  editorFontSize: 13,
  editorFontBold: true,
  editorAutoSave: "afterDelay",
  editorAutoSaveDelay: 1000,
  // 默认还是要问一句：第一次关窗口时得让用户知道工作区还在后台跑着
  closeToTray: false,
  rightFilesVisible: true,
  rightChangesVisible: true,
  rightSearchVisible: true,
  rightBrowserVisible: true,
  rightRemoteVisible: true,
  rightDatabaseVisible: true,
  rightPreviewVisible: true,
  shortcuts: defaultShortcuts(),
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

/** 逐条校验模型：id 是必填，缺了这条就没意义 */
function asModelList(value: unknown): ProviderModel[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): ProviderModel[] => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string") return [];
    return [
      {
        id: record.id,
        name: asString(record.name, ""),
        enabled: asBoolean(record.enabled, true),
      },
    ];
  });
}

/**
 * 逐条校验提供商。id 要能当 opencode 的 provider key 和 `provider/model` 的前缀用，
 * 含 `/` 会把引用切错，缺了则整条作废——都没法补救，直接丢。
 *
 * 密钥那一栏兼容两种来源：新数据只有 `apiKeySet` 布尔位；老数据是明文 `apiKey`，
 * 读出来挂成待搬迁值（见 `AiProvider.apiKey`），启动时写进系统钥匙串。
 */
function asProviderList(value: unknown): AiProvider[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((item): AiProvider[] => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || !record.id || record.id.includes("/")) return [];
    if (seen.has(record.id)) return [];
    seen.add(record.id);
    // 老版本的明文字段；空串等于没填过，不挂上去
    const legacy = asString(record.apiKey, "");
    const provider: AiProvider = {
      id: record.id,
      name: asString(record.name, record.id),
      baseUrl: asString(record.baseUrl, ""),
      apiKeySet: asBoolean(record.apiKeySet, false) || legacy !== "",
      models: asModelList(record.models),
      enabled: asBoolean(record.enabled, true),
    };
    if (legacy !== "") provider.apiKey = legacy;
    return [provider];
  });
}

/**
 * 老版本的单一接口配置（aiBaseUrl / aiModel / aiApiKey）迁移成一个提供商。
 *
 * 非破坏性：只在「没有提供商列表、且旧字段填过东西」时合成，用户能看到、能改；
 * 合成结果随下一次落盘变成正式数据，旧键到时自然消失。
 */
function migrateLegacyProvider(raw: Record<string, unknown>): AiProvider[] {
  const baseUrl = asString(raw.aiBaseUrl, "").trim();
  const model = asString(raw.aiModel, "").trim();
  const apiKey = asString(raw.aiApiKey, "");
  if (!baseUrl && !model && !apiKey) return [];
  const provider: AiProvider = {
    id: "codedock",
    name: "CodeDock",
    baseUrl,
    apiKeySet: apiKey !== "",
    models: model ? [{ id: model, name: model, enabled: true }] : [],
    enabled: true,
  };
  // 老版本的明文密钥挂成待搬迁值，启动时进系统钥匙串
  if (apiKey !== "") provider.apiKey = apiKey;
  return [provider];
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

/** 工作区层是按工作区路径索引的一张表，逐项校验；读坏的条目直接丢掉 */
function asWorkspaceLayers(value: unknown): Record<string, AgentLayer> {
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
  // 老版本没有 aiProviders，只有单一接口三件套：有就合成一个提供商，行为不变
  const saved = asProviderList(raw.aiProviders);
  const aiProviders = saved.length > 0 ? saved : migrateLegacyProvider(raw);

  return {
    aiCommands,
    aiProviders,
    aiDefaultProvider: asString(raw.aiDefaultProvider, DEFAULTS.aiDefaultProvider),
    aiDefaultModel: asString(raw.aiDefaultModel, DEFAULTS.aiDefaultModel),
    // 老版本的设置里没有这三个字段，asBoolean 回落 true 就是默认开着
    agentEnabled: asBoolean(raw.agentEnabled, DEFAULTS.agentEnabled),
    agentCommand: asString(raw.agentCommand, DEFAULTS.agentCommand),
    agentPort: clampPort(raw.agentPort, DEFAULTS.agentPort),
    agentPrimary: asString(raw.agentPrimary, DEFAULTS.agentPrimary),
    // 老版本的设置里没有这两项，回落成空层 / 空表；更早的字段叫 agentProjects，兜底读旧名
    agentGlobal: asLayer(raw.agentGlobal),
    agentWorkspaces: asWorkspaceLayers(raw.agentWorkspaces ?? raw.agentProjects),
    uiFontFamily: asString(raw.uiFontFamily, DEFAULTS.uiFontFamily),
    terminalShell: asString(raw.terminalShell, DEFAULTS.terminalShell),
    terminalFontFamily: asString(raw.terminalFontFamily, DEFAULTS.terminalFontFamily),
    terminalFontSize: clampSize(raw.terminalFontSize, DEFAULTS.terminalFontSize),
    terminalFontBold: asBoolean(raw.terminalFontBold, DEFAULTS.terminalFontBold),
    terminalTheme: asString(raw.terminalTheme, DEFAULTS.terminalTheme),
    terminalWaitHint: asBoolean(raw.terminalWaitHint, DEFAULTS.terminalWaitHint),
    editorFontFamily: asString(raw.editorFontFamily, DEFAULTS.editorFontFamily),
    editorFontSize: clampSize(raw.editorFontSize, DEFAULTS.editorFontSize),
    editorFontBold: asBoolean(raw.editorFontBold, DEFAULTS.editorFontBold),
    editorAutoSave: asAutoSave(raw.editorAutoSave),
    editorAutoSaveDelay: clampDelay(
      raw.editorAutoSaveDelay,
      DEFAULTS.editorAutoSaveDelay,
    ),
    // 老版本的设置里没有这个字段，回落 false：默认仍然弹确认框
    closeToTray: asBoolean(raw.closeToTray, DEFAULTS.closeToTray),
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
    rightRemoteVisible: asBoolean(
      raw.rightRemoteVisible,
      DEFAULTS.rightRemoteVisible,
    ),
    rightDatabaseVisible: asBoolean(
      raw.rightDatabaseVisible,
      DEFAULTS.rightDatabaseVisible,
    ),
    rightPreviewVisible: asBoolean(
      raw.rightPreviewVisible,
      DEFAULTS.rightPreviewVisible,
    ),
    // 老版本的设置里没有这个字段，resolveShortcuts 会给出厂默认
    shortcuts: resolveShortcuts(raw.shortcuts),
  };
}

interface SettingsValue {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  /** 整块回到出厂默认，设置面板上的每一项都算在内 */
  reset: () => void;
  /** 只把某个分类的字段写回出厂默认，其余分类不动 */
  resetSection: (section: SettingsSection) => void;
  /** 系统钥匙串相关的提示，空串表示一切正常。有值时设置面板要如实显示 */
  secretNotice: string;
}

const SettingsContext = createContext<SettingsValue | null>(null);

/**
 * 一份全新的出厂默认值。DEFAULTS 是模块级常量，数组和对象必须换新副本再挂进
 * state，否则哪天有人在原地改这些引用，默认值本身就跟着被改掉了。
 */
function freshDefaults(): Settings {
  return {
    ...DEFAULTS,
    aiCommands: DEFAULTS.aiCommands.map((item) => ({ ...item })),
    aiProviders: [],
    agentGlobal: emptyAgentLayer(),
    agentWorkspaces: {},
    shortcuts: defaultShortcuts(),
  };
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(readSaved);
  /** 钥匙串读不了 / 明文没搬成功时的原因，界面据此提示 */
  const [secretNotice, setSecretNotice] = useState("");

  useEffect(() => {
    try {
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // 写不进去只影响下次启动，本次会话照常生效
    }
  }, [settings]);

  // 界面字体挂到 <html> 的 CSS 变量上；styles.css 里 body 按它取字体
  useEffect(() => {
    document.documentElement.style.setProperty(
      "--ui-font-family",
      resolveUiFont(settings.uiFontFamily),
    );
  }, [settings.uiFontFamily]);

  // 另一个窗口改了设置就跟着走。storage 事件只在别的 document 触发，不会自回流
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== SETTINGS_KEY) return;
      setSettings(readSaved());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((current) => ({ ...current, ...patch }));
  }, []);

  /**
   * 启动时一次性把密钥收进系统钥匙串，并用钥匙串里的实情校正 `apiKeySet`。
   *
   * 只跑一次，所以刻意锁首次渲染的 `settings`：之后再变都是用户自己改的，不该被
   * 这里覆盖回去。两件事：
   * 1. 旧版本存在 localStorage 里的明文密钥（`aiKey`）写进钥匙串，成功即抹掉；
   *    失败就把明文留在原处等下次重试，并把原因顶到界面上——密钥是用户填的，
   *    宁可留着也不能悄悄丢掉。
   * 2. 拿钥匙串的真实条目校正标记。那个布尔位可能和实际对不上（用户在系统设置里
   *    删过条目、或换了机器）。钥匙串整个不可用时跳过这步，免得把标记全清成「未保存」。
   */
  useEffect(() => {
    let cancelled = false;
    const initial = settings;
    void (async () => {
      let writeError = "";
      const migrated = initial.aiProviders.filter(
        (provider) => (provider.apiKey ?? "") !== "",
      );
      for (const provider of migrated) {
        try {
          await setSecret(provider.id, provider.apiKey ?? "");
        } catch (reason) {
          writeError ||= String(reason);
        }
      }

      const status = await secretStatus(initial.aiProviders.map((provider) => provider.id));
      if (cancelled) return;

      // 搬迁成功的：抹掉明文、标记已存。有一个写失败就一个都不抹，宁可下次
      // 整批重来（写进钥匙串是覆盖，重来无害），也不留下一半明文一半半没搬的状态
      const cleared =
        writeError === "" ? new Set(migrated.map((provider) => provider.id)) : null;
      // 钥匙串的实情。读不了时为 null，表示这步跳过——否则会把标记全清成「未保存」
      const known = status.storeError === "" ? new Set(status.available) : null;

      setSettings((current) => ({
        ...current,
        aiProviders: current.aiProviders.map((provider) => {
          const next = { ...provider };
          if (cleared?.has(provider.id)) {
            delete next.apiKey;
            next.apiKeySet = true;
          }
          if (known) next.apiKeySet = known.has(provider.id);
          return next;
        }),
      }));
      setSecretNotice(status.storeError || writeError);
    })();
    return () => {
      cancelled = true;
    };
    // 一次性的 bootstrap，只认挂载时那份设置
  }, []);

  /** 整块回厂：每个字段都取 freshDefaults 里的新副本 */
  const reset = useCallback(() => {
    setSettings(freshDefaults());
  }, []);

  /** 只挑出该分类的键，从全新默认值里取值盖上去；别的分类原样保留 */
  const resetSection = useCallback((section: SettingsSection) => {
    const defaults = freshDefaults();
    setSettings((current) => {
      const patch: Partial<Settings> = {};
      for (const key of SECTION_KEYS[section]) {
        // 逐键赋值，值的来源是 freshDefaults 里各自的新副本
        (patch as Record<string, unknown>)[key] = defaults[key];
      }
      return { ...current, ...patch };
    });
  }, []);

  return (
    <SettingsContext.Provider value={{ settings, update, reset, resetSection, secretNotice }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings(): SettingsValue {
  const value = useContext(SettingsContext);
  if (!value) throw new Error("useSettings 必须在 SettingsProvider 内使用");
  return value;
}
