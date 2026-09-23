import type { ITheme } from "@xterm/xterm";
import xtermThemes from "xterm-theme";
import type { ResolvedTheme } from "./theme";

/**
 * 「跟随界面主题」时用的内置配色。和 styles.css 里的 --c-* 对齐，
 * 保证终端跟外面的面板是同一个调子。
 */
const BUILTIN: Record<ResolvedTheme, ITheme> = {
  dark: {
    background: "#0f1115",
    foreground: "#d7dce5",
    cursor: "#6ea8fe",
    cursorAccent: "#0f1115",
    selectionBackground: "#2c3445",
    black: "#1b1f27",
    red: "#f07178",
    green: "#7fd88f",
    yellow: "#e6c07b",
    blue: "#6ea8fe",
    magenta: "#c792ea",
    cyan: "#89ddff",
    white: "#d7dce5",
    brightBlack: "#5c6370",
    brightRed: "#ff8b92",
    brightGreen: "#a5e8b0",
    brightYellow: "#f2d191",
    brightBlue: "#8fc0ff",
    brightMagenta: "#dbb8f0",
    brightCyan: "#a5e8ff",
    brightWhite: "#ffffff",
  },
  // 浅色这套沿用 VS Code 浅色主题的 ANSI 调色板，跟编辑器的 Monaco 观感一致
  light: {
    background: "#ffffff",
    foreground: "#1f2430",
    cursor: "#2563eb",
    cursorAccent: "#ffffff",
    selectionBackground: "#cfdffb",
    black: "#000000",
    red: "#cd3131",
    green: "#00bc00",
    yellow: "#949800",
    blue: "#0451a5",
    magenta: "#bc05bc",
    cyan: "#0598bc",
    white: "#555555",
    brightBlack: "#666666",
    brightRed: "#cd3131",
    brightGreen: "#14ce14",
    brightYellow: "#b5ba00",
    brightBlue: "#0451a5",
    brightMagenta: "#bc05bc",
    brightCyan: "#0598bc",
    brightWhite: "#a5a5a5",
  },
};

/**
 * 下拉里给的常用主题，key 就是 xterm-theme 的导出名。
 * 那个包里有 150 多个 iTerm2 主题，全塞进下拉没人挑得动，这里只留常用的。
 */
const COMMON_KEYS = [
  "Dracula",
  "Gruvbox_Dark",
  "Solarized_Dark",
  "Solarized_Light",
  "Monokai_Vivid",
  "Material",
  "MaterialDark",
  "Cobalt2",
  "JetBrains_Darcula",
  "Github",
  "Atom",
  "Hybrid",
  "Zenburn",
  "Wombat",
  "Molokai",
  "Ocean",
  "Espresso",
  "Chalk",
];

/** 包里这几个名字没有下划线，直接当标签不好看，单独给个写法 */
const LABEL_OVERRIDES: Record<string, string> = {
  MaterialDark: "Material Dark",
};

export const TERMINAL_THEME_OPTIONS = COMMON_KEYS.map((key) => ({
  key,
  label: LABEL_OVERRIDES[key] ?? key.replace(/_/g, " "),
}));

/** 空 key 表示跟随界面主题；未知 key（比如包换了版本、主题被删）也回落内置配色 */
export function resolveTerminalTheme(
  key: string,
  fallback: ResolvedTheme,
): ITheme {
  if (!key) return BUILTIN[fallback];
  return xtermThemes[key] ?? BUILTIN[fallback];
}
