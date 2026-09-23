import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

export interface Settings {
  /** 终端工具条上 AI CLI 按钮可选的命令；多于一个时点按钮给下拉选择 */
  aiCommands: string[];
  /** 终端字体（CSS font-family），留空用默认 */
  terminalFontFamily: string;
  /** 终端字号（px） */
  terminalFontSize: number;
  /** 编辑器字体（CSS font-family），留空用默认 */
  editorFontFamily: string;
  /** 编辑器字号（px） */
  editorFontSize: number;
}

const SETTINGS_KEY = "codedock.settings";

export const FONT_SIZE_MIN = 11;
export const FONT_SIZE_MAX = 20;

/** 默认等宽字体栈：终端和编辑器共用，两处都留空时看到的还是同一个字体 */
export const DEFAULT_MONO_FONT =
  '"Cascadia Mono", Consolas, "JetBrains Mono", Menlo, monospace';

/** 字体名留空就回落默认栈，界面上允许清空、不至于把字体搞没 */
export function resolveFont(value: string): string {
  return value.trim() || DEFAULT_MONO_FONT;
}

const DEFAULTS: Settings = {
  aiCommands: ["claude", "codebuddy"],
  terminalFontFamily: "",
  terminalFontSize: 13,
  editorFontFamily: "",
  editorFontSize: 13,
};

function clampSize(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(value)));
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/** 数组字段只留字符串项；整个字段缺失才回落默认，用户清空列表是允许的 */
function asCommandList(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULTS.aiCommands];
  return value.filter((item): item is string => typeof item === "string");
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
    editorFontFamily: asString(raw.editorFontFamily, DEFAULTS.editorFontFamily),
    editorFontSize: clampSize(raw.editorFontSize, DEFAULTS.editorFontSize),
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
