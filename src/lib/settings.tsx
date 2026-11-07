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
import { useTheme } from "./theme";
import type { TranslateTarget } from "./types";
import { setWindowTransparency } from "./window";

/** 自动保存时机，四种跟 VS Code 的 files.autoSave 对齐 */
export type AutoSaveMode = "off" | "afterDelay" | "onFocusChange" | "onWindowChange";

/** 编辑器缩进宽度；auto 表示按文件内容探测（Monaco 默认行为） */
export type EditorIndent = "auto" | "2" | "4" | "8";

/**
 * 编辑器行高。存的是**倍数**而不是像素：Monaco 的 `lineHeight` 小于 8 时按
 * 「字号 × 该值」解释（em 语义，见 monaco 的 BareFontInfo），于是字号一变行高跟着变，
 * 不用在两边各算一次。1.6 与 CodeLite 的默认值一致。
 */
export type EditorLineHeight = "1.4" | "1.6" | "1.8";

export const EDITOR_LINE_HEIGHTS: EditorLineHeight[] = ["1.4", "1.6", "1.8"];

/** 编辑器字号出厂值。字号快捷键「重置字号」与设置面板都用它，别再写第二份字面量 */
export const DEFAULT_EDITOR_FONT_SIZE = 13;

/** 一条环境变量；允许键名暂时空着（正在输入），启动时跳过空键 */
export interface AgentEnvVar {
  key: string;
  value: string;
}

export interface AiCommand {
  name: string;
  command: string;
  /** 启动这个 CLI 时额外注入进程环境的环境变量，按顺序生效，同名后者覆盖前者 */
  env: AgentEnvVar[];
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
 * `id` 一旦生成就不再变（改名也不变）：它同时是模型引用的前缀（`provider/model`）
 * 和钥匙串里密钥条目名的来源。
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
  /** 自动检查软件更新；下载与安装始终由用户手动确认 */
  updateAutoCheck: boolean;
  updateIntervalHours: number;
  updateSkippedVersion: string;
  /** 终端工具条上 AI CLI 按钮可选的配置；多于一个时点按钮给下拉选择 */
  aiCommands: AiCommand[];
  /** LLM 提供商列表，智能体与 AI 生成提交信息共用 */
  aiProviders: AiProvider[];
  /** 全局默认模型所在的提供商 id；空或失效时回落到第一个启用项 */
  aiDefaultProvider: string;
  /** 全局默认模型 id；空或失效时回落到该提供商的第一个启用模型 */
  aiDefaultModel: string;
  /**
   * 文档翻译的目标语言。翻译复用上面的默认模型与钥匙串里的密钥，
   * 不单独存接口地址 / 模型 / API Key。
   */
  translateTarget: TranslateTarget;
  /**
   * @deprecated 工作区层的智能体配置已改以工作区根下 `.codovo/` 的文件为准，
   * 这里只保留旧数据用于一次性迁移（见 lib/agent-config.ts 的 readWorkspaceLayer）。
   * 新代码不要再读写它。
   */
  agentWorkspaces: Record<string, AgentLayer>;
  /**
   * 界面透明度（百分比，100 表示不透明）。调低后窗口底色透出桌面，同时让系统在窗口后面
   * 铺一层毛玻璃（Windows 用 Mica / Acrylic、macOS 用 Vibrancy）。终端与编辑器各自画
   * 底色，也跟着一起变半透明——透出来的是它们自己主题的颜色，不是外面板子的色。
   */
  uiOpacity: number;
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
   * 终端是否用 WebGL 渲染（GPU 加速）。关掉退回 xterm 内置的 DOM 渲染器：重输出时
   * 略费 CPU，但能避开 WebGL 渲染器的花屏——它的字形纹理图集在页合并时会让画面
   * 整块花掉，得等一次布局变化（触发 resize）重画才恢复。只对新建的终端生效。
   */
  terminalGpuAcceleration: boolean;
  /**
   * 终端里 AI CLI 停在需要用户输入的提示上、或一轮任务跑完回到空闲等指令时，
   * 在标签与侧栏标出来。判据是备用屏上的输出特征，属于启发式、可能误报，所以留个开关。
   */
  terminalWaitHint: boolean;
  /** 编辑器字体（CSS font-family），留空用默认 */
  editorFontFamily: string;
  /** 界面等宽字体（CSS font-family），作用于配置框等 font-mono 界面文本；留空跟随编辑器字体 */
  uiMonoFontFamily: string;
  /** 编辑器字号（px） */
  editorFontSize: number;
  /** 编辑器字体是否加粗 */
  editorFontBold: boolean;
  /** 编辑器是否显示右侧缩略图（minimap） */
  editorMinimap: boolean;
  /** 编辑器里的长行是否自动折行；默认开，读长注释和文档时不用来回横向滚 */
  editorWordWrap: boolean;
  /** 编辑器缩进宽度；auto 按文件内容探测，否则固定用该数量的空格 */
  editorIndent: EditorIndent;
  /** 编辑器是否显示行号 */
  editorLineNumbers: boolean;
  /** 是否高亮光标所在的那一行 */
  editorHighlightActiveLine: boolean;
  /** 行高倍数，直接交给 Monaco 的 lineHeight 选项（见 EditorLineHeight） */
  editorLineHeight: EditorLineHeight;
  /** 编辑器自动保存时机 */
  editorAutoSave: AutoSaveMode;
  /** afterDelay 模式下停手多久才落盘（毫秒） */
  editorAutoSaveDelay: number;
  /** 保存时先用 Prettier 格式化一遍再落盘。默认关：不是所有项目都接受 Prettier 的风格 */
  editorFormatOnSave: boolean;
  /** 保存前用 Prettier 解析器做一次语法校验。默认开：配置文件写坏了能及时发现 */
  editorCheckSyntaxOnSave: boolean;
  /**
   * 关窗口时直接收进托盘、不再问。开着工作区才用得着——没工作区时关闭就是退出。
   * 用户在某次确认框里勾了「不再提醒」就会置成 true
   */
  closeToTray: boolean;
  /** 启动时恢复上次打开的工作区；关掉就每次从空界面开始（记录留着，开回来还在） */
  restoreWorkspace: boolean;
  /** 右边栏的各个模块：关掉哪个，图标条上就不出哪个入口 */
  rightFilesVisible: boolean;
  rightChangesVisible: boolean;
  rightBrowserVisible: boolean;
  rightRemoteVisible: boolean;
  rightDatabaseVisible: boolean;
  rightPreviewVisible: boolean;
  rightDeployVisible: boolean;
  /** 应用命令的键位，按命令 id 索引；值的写法见 lib/shortcuts.ts */
  shortcuts: Record<string, string>;
}

const SETTINGS_KEY = "codovo.settings";

/**
 * 设置面板上可单独恢复默认的分类，和 SettingsDialog 的 tab 一一对应。
 * `dependencies` 只有环境检测与安装、没有设置项，所以不在这里。
 */
export type SettingsSection =
  | "appearance"
  | "terminal"
  | "editor"
  | "shortcuts"
  | "agents"
  | "agent"
  | "about";

/**
 * 每个分类各管哪些字段。恢复某一页默认时只把这些键写回出厂值，别的分类原样留着。
 * 新增设置项时把它加进对应分类，否则「恢复本页默认」会漏掉它。
 *
 * 注意 `appearance` 里的主题不在 Settings 上（在 theme.tsx），由设置面板另外处理。
 */
const SECTION_KEYS: Record<SettingsSection, (keyof Settings)[]> = {
  appearance: [
    "uiOpacity",
    "uiFontFamily",
    "terminalFontFamily",
    "terminalFontSize",
    "terminalFontBold",
    "editorFontFamily",
    "uiMonoFontFamily",
    "editorFontSize",
    "editorFontBold",
    "rightFilesVisible",
    "rightChangesVisible",
    "rightBrowserVisible",
    "rightRemoteVisible",
    "rightDatabaseVisible",
    "rightPreviewVisible",
    "rightDeployVisible",
    "closeToTray",
    "restoreWorkspace",
  ],
  terminal: [
    "terminalShell",
    "terminalTheme",
    "terminalGpuAcceleration",
    "terminalWaitHint",
  ],
  editor: [
    "editorAutoSave",
    "editorAutoSaveDelay",
    "editorFormatOnSave",
    "editorCheckSyntaxOnSave",
    "editorMinimap",
    "editorWordWrap",
    "editorIndent",
    "editorLineNumbers",
    "editorHighlightActiveLine",
    "editorLineHeight",
  ],
  shortcuts: ["shortcuts"],
  // 编程 Agent 从「终端」页独立出来：命令和环境变量都属于 Agent 本身
  agents: ["aiCommands"],
  agent: [
    "aiProviders",
    "aiDefaultProvider",
    "aiDefaultModel",
    // 翻译复用 AI 默认模型，放在「AI」分类里恢复默认更符合用户直觉
    "translateTarget",
    "agentWorkspaces",
  ],
  about: ["updateAutoCheck", "updateIntervalHours", "updateSkippedVersion"],
};

export const FONT_SIZE_MIN = 11;
export const FONT_SIZE_MAX = 20;
/** 界面透明度的取值范围（百分比）。下限 50 是为了半透明状态下文字还看得清 */
export const UI_OPACITY_MIN = 50;
export const UI_OPACITY_MAX = 100;
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

/** 智能体的 mode 取值；`.codovo/agents.json` 里也这么写 */
const AGENT_MODES: AgentProfile["mode"][] = ["primary", "subagent", "all"];

/** 新的一层空配置。工厂而不是常量：多处会各自持有、不能被共享引用串改 */
export function emptyAgentLayer(): AgentLayer {
  return { rules: "", memory: "", skills: [], agents: [] };
}

const DEFAULTS: Settings = {
  updateAutoCheck: true,
  updateIntervalHours: 24,
  updateSkippedVersion: "",
  // name 用各家的规范写法（与 lib/cli-sessions.ts 的 CLI_PROVIDERS.label 对齐），
  // command 才是实际会跑的可执行文件名
  aiCommands: [
    { name: "Claude Code", command: "claude", env: [] },
    { name: "Codex", command: "codex --no-daemon", env: [] },
    { name: "Antigravity", command: "agy", env: [] },
    { name: "CodeBuddy", command: "codebuddy", env: [] },
    { name: "opencode", command: "opencode", env: [] },
  ],
  // 不预置任何厂商：提供商和模型都由用户自己加
  aiProviders: [],
  aiDefaultProvider: "",
  aiDefaultModel: "",
  // 默认译成简体中文；用户可以在设置或翻译视图里随时切换
  translateTarget: "zh",
  agentWorkspaces: {},
  // 默认不透明：透明窗口在部分平台（无合成器的 Linux）会露底，得用户主动开
  uiOpacity: UI_OPACITY_MAX,
  uiFontFamily: "",
  terminalShell: "",
  terminalFontFamily: "",
  terminalFontSize: 13,
  terminalFontBold: true,
  terminalTheme: "",
  // 默认使用 DOM 渲染器，避免 WebGL 在部分 Windows 显卡 / DPI 缩放组合下字体发虚或花屏
  terminalGpuAcceleration: false,
  terminalWaitHint: true,
  editorFontFamily: "",
  uiMonoFontFamily: "",
  editorFontSize: DEFAULT_EDITOR_FONT_SIZE,
  editorFontBold: true,
  // 默认收起：窄面板里 minimap 会挤占正文宽度；需要时在设置里打开
  editorMinimap: false,
  // 默认开着：长注释和文档不用横向滚动，窄面板里读起来更顺
  editorWordWrap: true,
  // 默认按文件内容探测（Monaco 原行为），别一上来就强行统一缩进
  editorIndent: "auto",
  // 行号与当前行高亮都默认开：这两样是编辑器的基本参照物
  editorLineNumbers: true,
  editorHighlightActiveLine: true,
  // 1.6 与 CodeLite 一致；Monaco 自己的默认是 1.5（mac）/ 1.35（其余平台）
  editorLineHeight: "1.6",
  editorAutoSave: "afterDelay",
  editorAutoSaveDelay: 1000,
  // 默认关：Prettier 的风格不一定符合每个项目的习惯，得用户主动开
  editorFormatOnSave: false,
  // 默认开：写坏配置文件（少个括号、多个逗号）时提示一下，代价很低
  editorCheckSyntaxOnSave: true,
  // 默认还是要问一句：第一次关窗口时得让用户知道工作区还在后台跑着
  closeToTray: false,
  // 默认接着上次的位置：用户上次停在哪就恢复到哪
  restoreWorkspace: true,
  rightFilesVisible: true,
  rightChangesVisible: true,
  rightBrowserVisible: true,
  rightRemoteVisible: true,
  rightDatabaseVisible: true,
  rightPreviewVisible: true,
  rightDeployVisible: true,
  shortcuts: defaultShortcuts(),
};

function clampSize(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(value)));
}

/** 透明度同样是百分比整数；读坏了（含老版本没有这个字段）回落 100，也就是不透明 */
function clampOpacity(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(UI_OPACITY_MAX, Math.max(UI_OPACITY_MIN, Math.round(value)));
}

function clampDelay(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(AUTOSAVE_DELAY_MAX, Math.max(AUTOSAVE_DELAY_MIN, Math.round(value)));
}

/** 存的是字符串，但值域是固定的四个；读坏了回落默认 */
function asAutoSave(value: unknown): AutoSaveMode {
  return AUTO_SAVE_MODES.includes(value as AutoSaveMode)
    ? (value as AutoSaveMode)
    : DEFAULTS.editorAutoSave;
}

const EDITOR_INDENTS: EditorIndent[] = ["auto", "2", "4", "8"];

/** 翻译目标语言只有中英两种，读坏了（含老版本没有这个字段）回落默认 */
function asTranslateTarget(value: unknown): TranslateTarget {
  return value === "en" ? "en" : DEFAULTS.translateTarget;
}

/** 缩进宽度同理：值域固定，读坏了回落 auto */
function asEditorIndent(value: unknown): EditorIndent {
  return EDITOR_INDENTS.includes(value as EditorIndent)
    ? (value as EditorIndent)
    : DEFAULTS.editorIndent;
}

/** 行高同理：值域是固定的三档，读坏了（含老版本没有这个字段）回落默认 */
function asEditorLineHeight(value: unknown): EditorLineHeight {
  return EDITOR_LINE_HEIGHTS.includes(value as EditorLineHeight)
    ? (value as EditorLineHeight)
    : DEFAULTS.editorLineHeight;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** 环境变量列表：键名必须是字符串，值缺失按空串处理；空键留给界面编辑，启动时再过滤 */
function asEnvList(value: unknown): AgentEnvVar[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): AgentEnvVar[] => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (typeof record.key !== "string") return [];
    return [{ key: record.key, value: asString(record.value, "") }];
  });
}

function asCommandList(value: unknown): AiCommand[] {
  if (!Array.isArray(value)) return [...DEFAULTS.aiCommands];
  return value.flatMap((item): AiCommand[] => {
    if (typeof item === "string") return [{ name: item, command: item, env: [] }];
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (typeof record.name !== "string" || typeof record.command !== "string") return [];
    // 老版本没有 env 字段，回落空表即可
    return [{ name: record.name, command: record.command, env: asEnvList(record.env) }];
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
 * 逐条校验提供商。id 要能当 `provider/model` 的前缀用，
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
    id: "codovo",
    name: "Codovo",
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

/** 逐条校验技能：名字和描述是必填项（后端要把它们写进提示词），缺了就丢掉这条 */
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
    updateAutoCheck: asBoolean(raw.updateAutoCheck, DEFAULTS.updateAutoCheck),
    updateIntervalHours: [1, 6, 12, 24].includes(Number(raw.updateIntervalHours))
      ? Number(raw.updateIntervalHours)
      : DEFAULTS.updateIntervalHours,
    updateSkippedVersion: asString(raw.updateSkippedVersion, ""),
    aiCommands,
    aiProviders,
    aiDefaultProvider: asString(raw.aiDefaultProvider, DEFAULTS.aiDefaultProvider),
    aiDefaultModel: asString(raw.aiDefaultModel, DEFAULTS.aiDefaultModel),
    // 老版本的设置里没有这一项，回落 zh
    translateTarget: asTranslateTarget(raw.translateTarget),
    // 老版本的设置里没有这一项，回落成空表；更早的字段叫 agentProjects，兜底读旧名。
    // 只用于一次性迁移到 `.codovo/`（见 lib/agent-config.ts 的 readWorkspaceLayer）
    agentWorkspaces: asWorkspaceLayers(raw.agentWorkspaces ?? raw.agentProjects),
    uiOpacity: clampOpacity(raw.uiOpacity, DEFAULTS.uiOpacity),
    uiFontFamily: asString(raw.uiFontFamily, DEFAULTS.uiFontFamily),
    terminalShell: asString(raw.terminalShell, DEFAULTS.terminalShell),
    terminalFontFamily: asString(raw.terminalFontFamily, DEFAULTS.terminalFontFamily),
    terminalFontSize: clampSize(raw.terminalFontSize, DEFAULTS.terminalFontSize),
    terminalFontBold: asBoolean(raw.terminalFontBold, DEFAULTS.terminalFontBold),
    terminalTheme: asString(raw.terminalTheme, DEFAULTS.terminalTheme),
    // 老版本的设置里没有这个字段，回落 false：优先保证终端文字清晰；需要时可手动开启 GPU 加速
    terminalGpuAcceleration: asBoolean(
      raw.terminalGpuAcceleration,
      DEFAULTS.terminalGpuAcceleration,
    ),
    terminalWaitHint: asBoolean(raw.terminalWaitHint, DEFAULTS.terminalWaitHint),
    editorFontFamily: asString(raw.editorFontFamily, DEFAULTS.editorFontFamily),
    uiMonoFontFamily: asString(raw.uiMonoFontFamily, DEFAULTS.uiMonoFontFamily),
    editorFontSize: clampSize(raw.editorFontSize, DEFAULTS.editorFontSize),
    editorFontBold: asBoolean(raw.editorFontBold, DEFAULTS.editorFontBold),
    editorMinimap: asBoolean(raw.editorMinimap, DEFAULTS.editorMinimap),
    // 老版本的设置里没有这个字段，回落 true：长行默认折行
    editorWordWrap: asBoolean(raw.editorWordWrap, DEFAULTS.editorWordWrap),
    editorIndent: asEditorIndent(raw.editorIndent),
    // 老版本的设置里没有这三项，回落成「行号开 / 当前行高亮开 / 1.6 倍行高」
    editorLineNumbers: asBoolean(raw.editorLineNumbers, DEFAULTS.editorLineNumbers),
    editorHighlightActiveLine: asBoolean(
      raw.editorHighlightActiveLine,
      DEFAULTS.editorHighlightActiveLine,
    ),
    editorLineHeight: asEditorLineHeight(raw.editorLineHeight),
    editorAutoSave: asAutoSave(raw.editorAutoSave),
    editorAutoSaveDelay: clampDelay(
      raw.editorAutoSaveDelay,
      DEFAULTS.editorAutoSaveDelay,
    ),
    // 这两个字段老版本的设置里没有：一个回落 false（默认不格式化）、一个回落 true（默认校验）
    editorFormatOnSave: asBoolean(raw.editorFormatOnSave, DEFAULTS.editorFormatOnSave),
    editorCheckSyntaxOnSave: asBoolean(
      raw.editorCheckSyntaxOnSave,
      DEFAULTS.editorCheckSyntaxOnSave,
    ),
    // 老版本的设置里没有这个字段，回落 false：默认仍然弹确认框
    closeToTray: asBoolean(raw.closeToTray, DEFAULTS.closeToTray),
    restoreWorkspace: asBoolean(raw.restoreWorkspace, DEFAULTS.restoreWorkspace),
    // 老版本的设置里没有这几个字段，asBoolean 会回落到 true，也就是默认全展示
    rightFilesVisible: asBoolean(raw.rightFilesVisible, DEFAULTS.rightFilesVisible),
    rightChangesVisible: asBoolean(
      raw.rightChangesVisible,
      DEFAULTS.rightChangesVisible,
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
    rightDeployVisible: asBoolean(
      raw.rightDeployVisible,
      DEFAULTS.rightDeployVisible,
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
    aiCommands: DEFAULTS.aiCommands.map((item) => ({
      ...item,
      env: item.env.map((entry) => ({ ...entry })),
    })),
    aiProviders: [],
    agentWorkspaces: {},
    shortcuts: defaultShortcuts(),
  };
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  // 窗口背景效果要按当前主题深浅着色（跟随系统时这里拿到的已经是解析后的结果）
  const { theme } = useTheme();
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

  // 低于 100% 时给 macOS / Windows 铺系统 backdrop；Linux 交给桌面合成器处理。
  useEffect(() => {
    void setWindowTransparency(settings.uiOpacity, theme === "dark").catch(() => {});
  }, [settings.uiOpacity, theme]);

  /**
   * 界面的透明度：styles.css 里各层底色（bg-app / bg-panel / bg-surface …）都按它折算成
   * rgba，改这一个变量整片界面就一起半透明，组件里不用各自处理。
   *
   * 根节点那层底色（--ui-window-alpha）跟它不同步：半透明时根节点必须全透明，否则侧栏
   * 底下先垫一层 85%、侧栏自己再叠一层 85%，乘起来是 98%，看着跟没开一样。
   */
  useEffect(() => {
    const root = document.documentElement.style;
    const opaque = settings.uiOpacity >= UI_OPACITY_MAX;
    root.setProperty("--ui-alpha", opaque ? "100%" : `${settings.uiOpacity}%`);
    root.setProperty("--ui-window-alpha", opaque ? "100%" : "0%");
  }, [settings.uiOpacity]);

  // 界面字体挂到 <html> 的 CSS 变量上；styles.css 里 body 按它取字体
  useEffect(() => {
    document.documentElement.style.setProperty(
      "--ui-font-family",
      resolveUiFont(settings.uiFontFamily),
    );
  }, [settings.uiFontFamily]);

  // 界面等宽字体挂到 --font-mono 上（配置框等 font-mono 界面文本用）；留空跟随编辑器字体
  useEffect(() => {
    document.documentElement.style.setProperty(
      "--font-mono",
      settings.uiMonoFontFamily.trim() || resolveFont(settings.editorFontFamily),
    );
  }, [settings.uiMonoFontFamily, settings.editorFontFamily]);

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
