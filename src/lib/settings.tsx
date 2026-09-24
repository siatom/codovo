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

export interface Settings {
  /** 终端工具条上 AI CLI 按钮可选的配置；多于一个时点按钮给下拉选择 */
  aiCommands: AiCommand[];
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

const DEFAULTS: Settings = {
  aiCommands: [
    { name: "claude", command: "claude" },
    { name: "codebuddy", command: "codebuddy" },
  ],
  terminalFontFamily: "",
  terminalFontSize: 13,
  terminalFontBold: false,
  terminalTheme: "",
  editorFontFamily: "",
  editorFontSize: 13,
  editorFontBold: false,
  editorAutoSave: "off",
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

  return (
    <SettingsContext.Provider value={{ settings, update }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings(): SettingsValue {
  const value = useContext(SettingsContext);
  if (!value) throw new Error("useSettings 必须在 SettingsProvider 内使用");
  return value;
}
