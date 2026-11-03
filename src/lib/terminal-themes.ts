import type { ITheme } from "@xterm/xterm";
import xtermThemes from "xterm-theme";
import type { ResolvedTheme, Theme } from "./theme";

/**
 * 「跟随界面主题」时用的内置配色。和 styles.css 里的 --c-* 对齐，
 * 保证终端跟外面的面板是同一个调子。
 */
const BUILTIN: Record<ResolvedTheme, ITheme> = {
  dark: {
    background: "#080b0f",
    foreground: "#d7dce5",
    cursor: "#6ea8fe",
    cursorAccent: "#080b0f",
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
 * 每套界面配色对应的终端调色板：background / foreground / cursor /
 * selectionBackground 直接取该主题的 --c-surface / --c-fg / --c-accent /
 * --c-selected，ANSI 十六色用各主题的官方调色板。
 *
 * **别改回 xterm-theme 里的近似主题**：那些 iTerm2 主题的底色跟界面面板对不上
 * （neon-green 曾映射到 Monokai_Vivid、vscode 映射到一个不存在的 Default_Dark），
 * 跟随界面主题时终端底色和四周面板会差出一块，一眼就看出来。
 */
const PALETTE: Record<Exclude<Theme, "system">, ITheme> = {
  dark: BUILTIN.dark,
  light: BUILTIN.light,
  vscode: {
    background: "#121212", foreground: "#cccccc", cursor: "#3794ff", cursorAccent: "#121212",
    selectionBackground: "#04395e",
    black: "#000000", red: "#cd3131", green: "#0dbc79", yellow: "#e5e510",
    blue: "#2472c8", magenta: "#bc3fbc", cyan: "#11a8cd", white: "#e5e5e5",
    brightBlack: "#666666", brightRed: "#f14c4c", brightGreen: "#23d18b", brightYellow: "#f5f543",
    brightBlue: "#3b8eea", brightMagenta: "#d670d6", brightCyan: "#29b8db", brightWhite: "#e5e5e5",
  },
  // VS Code Light+ 的终端 ANSI 跟内置浅色同一套，只是把底 / 前景 / 光标对齐到 Light+ 的界面色
  "vscode-light": {
    background: "#ffffff", foreground: "#333333", cursor: "#006ab1", cursorAccent: "#ffffff",
    selectionBackground: "#d6ebff",
    black: "#000000", red: "#cd3131", green: "#00bc00", yellow: "#949800",
    blue: "#0451a5", magenta: "#bc05bc", cyan: "#0598bc", white: "#555555",
    brightBlack: "#666666", brightRed: "#cd3131", brightGreen: "#14ce14", brightYellow: "#b5ba00",
    brightBlue: "#0451a5", brightMagenta: "#bc05bc", brightCyan: "#0598bc", brightWhite: "#a5a5a5",
  },
  "one-dark": {
    background: "#1a1d23", foreground: "#abb2bf", cursor: "#61afef", cursorAccent: "#1a1d23",
    selectionBackground: "#334255",
    black: "#282c34", red: "#e06c75", green: "#98c379", yellow: "#e5c07b",
    blue: "#61afef", magenta: "#c678dd", cyan: "#56b6c2", white: "#abb2bf",
    brightBlack: "#5c6370", brightRed: "#e06c75", brightGreen: "#98c379", brightYellow: "#e5c07b",
    brightBlue: "#61afef", brightMagenta: "#c678dd", brightCyan: "#56b6c2", brightWhite: "#ffffff",
  },
  dracula: {
    background: "#1a1b23", foreground: "#f8f8f2", cursor: "#bd93f9", cursorAccent: "#1a1b23",
    selectionBackground: "#44475a",
    black: "#21222c", red: "#ff5555", green: "#50fa7b", yellow: "#f1fa8c",
    blue: "#bd93f9", magenta: "#ff79c6", cyan: "#8be9fd", white: "#f8f8f2",
    brightBlack: "#6272a4", brightRed: "#ff6e6e", brightGreen: "#69ff94", brightYellow: "#ffffa5",
    brightBlue: "#d6acff", brightMagenta: "#ff92df", brightCyan: "#a4ffff", brightWhite: "#ffffff",
  },
  "github-dark": {
    background: "#080c11", foreground: "#e6edf3", cursor: "#58a6ff", cursorAccent: "#080c11",
    selectionBackground: "#16345a",
    black: "#484f58", red: "#ff7b72", green: "#3fb950", yellow: "#d29922",
    blue: "#58a6ff", magenta: "#bc8cff", cyan: "#39c5cf", white: "#b1bac4",
    brightBlack: "#6e7681", brightRed: "#ffa198", brightGreen: "#56d364", brightYellow: "#e3b341",
    brightBlue: "#79c0ff", brightMagenta: "#d2a8ff", brightCyan: "#56d4dd", brightWhite: "#f0f6fc",
  },
  "github-light": {
    background: "#ffffff", foreground: "#1f2328", cursor: "#0969da", cursorAccent: "#ffffff",
    selectionBackground: "#ddf4ff",
    black: "#24292f", red: "#cf222e", green: "#116329", yellow: "#4d2d00",
    blue: "#0969da", magenta: "#8250df", cyan: "#1b7c83", white: "#6e7781",
    brightBlack: "#57606a", brightRed: "#a40e26", brightGreen: "#1a7f37", brightYellow: "#633c01",
    brightBlue: "#218bff", brightMagenta: "#a475f9", brightCyan: "#3192aa", brightWhite: "#8c959f",
  },
  "material-nova": {
    background: "#191d27", foreground: "#d8dee9", cursor: "#82aaff", cursorAccent: "#191d27",
    selectionBackground: "#344052",
    black: "#263238", red: "#ff5370", green: "#c3e88d", yellow: "#ffcb6b",
    blue: "#82aaff", magenta: "#c792ea", cyan: "#89ddff", white: "#eeffff",
    brightBlack: "#546e7a", brightRed: "#ff5370", brightGreen: "#c3e88d", brightYellow: "#ffcb6b",
    brightBlue: "#82aaff", brightMagenta: "#c792ea", brightCyan: "#89ddff", brightWhite: "#ffffff",
  },
  "neon-green": {
    background: "#060d09", foreground: "#d9ffe2", cursor: "#39ff88", cursorAccent: "#060d09",
    selectionBackground: "#174d32",
    black: "#122019", red: "#ff8b92", green: "#39ff88", yellow: "#e6c07b",
    blue: "#6ea8fe", magenta: "#c792ea", cyan: "#89ddff", white: "#d9ffe2",
    brightBlack: "#4e805f", brightRed: "#ffa3a9", brightGreen: "#83ffb2", brightYellow: "#f2d191",
    brightBlue: "#8fc0ff", brightMagenta: "#dbb8f0", brightCyan: "#a5e8ff", brightWhite: "#ffffff",
  },
  "tokyo-night": {
    background: "#13141d", foreground: "#c0caf5", cursor: "#7aa2f7", cursorAccent: "#13141d",
    selectionBackground: "#283457",
    black: "#15161e", red: "#f7768e", green: "#9ece6a", yellow: "#e0af68",
    blue: "#7aa2f7", magenta: "#bb9af7", cyan: "#7dcfff", white: "#a9b1d6",
    brightBlack: "#414868", brightRed: "#f7768e", brightGreen: "#9ece6a", brightYellow: "#e0af68",
    brightBlue: "#7aa2f7", brightMagenta: "#bb9af7", brightCyan: "#7dcfff", brightWhite: "#c0caf5",
  },
  "catppuccin-mocha": {
    background: "#12121c", foreground: "#cdd6f4", cursor: "#cba6f7", cursorAccent: "#12121c",
    selectionBackground: "#3e3358",
    black: "#45475a", red: "#f38ba8", green: "#a6e3a1", yellow: "#f9e2af",
    blue: "#89b4fa", magenta: "#f5c2e7", cyan: "#94e2d5", white: "#bac2de",
    brightBlack: "#585b70", brightRed: "#f38ba8", brightGreen: "#a6e3a1", brightYellow: "#f9e2af",
    brightBlue: "#89b4fa", brightMagenta: "#f5c2e7", brightCyan: "#94e2d5", brightWhite: "#a6adc8",
  },
  nord: {
    background: "#262b35", foreground: "#d8dee9", cursor: "#8fbcbb", cursorAccent: "#262b35",
    selectionBackground: "#3b5878",
    black: "#3b4252", red: "#bf616a", green: "#a3be8c", yellow: "#ebcb8b",
    blue: "#81a1c1", magenta: "#b48ead", cyan: "#88c0d0", white: "#e5e9f0",
    brightBlack: "#4c566a", brightRed: "#bf616a", brightGreen: "#a3be8c", brightYellow: "#ebcb8b",
    brightBlue: "#81a1c1", brightMagenta: "#b48ead", brightCyan: "#8fbcbb", brightWhite: "#eceff4",
  },
  "solarized-dark": {
    background: "#00222b", foreground: "#93a1a1", cursor: "#268bd2", cursorAccent: "#00222b",
    selectionBackground: "#10485f",
    black: "#073642", red: "#dc322f", green: "#859900", yellow: "#b58900",
    blue: "#268bd2", magenta: "#d33682", cyan: "#2aa198", white: "#eee8d5",
    brightBlack: "#002b36", brightRed: "#cb4b16", brightGreen: "#586e75", brightYellow: "#657b83",
    brightBlue: "#839496", brightMagenta: "#6c71c4", brightCyan: "#93a1a1", brightWhite: "#fdf6e3",
  },
  "solarized-light": {
    background: "#fdf6e3", foreground: "#073642", cursor: "#268bd2", cursorAccent: "#fdf6e3",
    selectionBackground: "#d6e8f2",
    black: "#073642", red: "#dc322f", green: "#859900", yellow: "#b58900",
    blue: "#268bd2", magenta: "#d33682", cyan: "#2aa198", white: "#eee8d5",
    brightBlack: "#002b36", brightRed: "#cb4b16", brightGreen: "#586e75", brightYellow: "#657b83",
    brightBlue: "#839496", brightMagenta: "#6c71c4", brightCyan: "#93a1a1", brightWhite: "#fdf6e3",
  },
  monokai: {
    background: "#1f201b", foreground: "#f8f8f2", cursor: "#66d9ef", cursorAccent: "#1f201b",
    selectionBackground: "#3a4a4a",
    black: "#272822", red: "#f92672", green: "#a6e22e", yellow: "#f4bf75",
    blue: "#66d9ef", magenta: "#ae81ff", cyan: "#a1efe4", white: "#f8f8f2",
    brightBlack: "#75715e", brightRed: "#f92672", brightGreen: "#a6e22e", brightYellow: "#f4bf75",
    brightBlue: "#66d9ef", brightMagenta: "#ae81ff", brightCyan: "#a1efe4", brightWhite: "#f9f8f5",
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

/**
 * 按界面透明度把配色里的底色换成半透明，让终端也透出桌面。
 *
 * 只有开着 xterm 的 `allowTransparency` 才认带 alpha 的底色（见 TerminalSession）。
 * 光标上的字（cursorAccent）不跟着透明：它压在光标色上，透了会露出底下的字。
 */
export function translucentTheme(theme: ITheme, percent: number): ITheme {
  // 没写底色的配色由 xterm 自己兜底（用默认黑），这里不动它
  if (percent >= 100 || !theme.background) return theme;
  const alpha = Math.max(0, Math.min(1, percent / 100));
  return { ...theme, background: withAlpha(theme.background, alpha) };
}

/** `#rgb` / `#rrggbb` 转成 rgba()；认不出的写法原样返回——宁可完全不透明也别画错颜色 */
function withAlpha(color: string, alpha: number): string {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!match) return color;
  const hex =
    match[1].length === 3
      ? match[1]
          .split("")
          .map((char) => char + char)
          .join("")
      : match[1];
  const value = Number.parseInt(hex, 16);
  return `rgba(${(value >> 16) & 0xff}, ${(value >> 8) & 0xff}, ${value & 0xff}, ${alpha})`;
}

/** 空 key 表示跟随界面主题；未知 key（比如包换了版本、主题被删）也回落内置配色 */
export function resolveTerminalTheme(
  key: string,
  fallback: ResolvedTheme,
  preference?: Theme,
): ITheme {
  if (!key) {
    // 跟随界面主题：用该配色专用的终端调色板；system 没有固定色，按系统明暗走内置
    return preference && preference !== "system" ? PALETTE[preference] : BUILTIN[fallback];
  }
  return xtermThemes[key] ?? BUILTIN[fallback];
}
