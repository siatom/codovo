import * as monaco from "monaco-editor";
// monaco-editor 的 exports map 是 "./*" -> "./esm/vs/*.js"，所以这里不能再写 esm/vs 前缀
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";

import { registerJsonLikeLanguages } from "./json5";
import type { Theme } from "./theme";

/**
 * Monaco 默认从 CDN 拉 worker，桌面端必须离线。这里用 Vite 的 `?worker`
 * 把 worker 打进产物，再交给 MonacoEnvironment 分发。
 */
declare global {
  interface Window {
    MonacoEnvironment?: monaco.Environment;
  }
}

window.MonacoEnvironment = {
  getWorker(_moduleId, label) {
    switch (label) {
      case "json":
        return new JsonWorker();
      case "css":
      case "scss":
      case "less":
        return new CssWorker();
      case "html":
      case "handlebars":
      case "razor":
        return new HtmlWorker();
      case "typescript":
      case "javascript":
        return new TsWorker();
      default:
        return new EditorWorker();
    }
  },
};

export const DARK_THEME = "codedock-dark";
export const LIGHT_THEME = "codedock-light";
export function monacoThemeFor(preference: Theme, theme: "dark" | "light") {
  return preference === "vscode" || preference === "vscode-light" || preference === "one-dark" || preference === "dracula" || preference === "github-dark" || preference === "github-light" || preference === "material-nova" || preference === "neon-green" || preference === "tokyo-night" || preference === "catppuccin-mocha" || preference === "nord" || preference === "solarized-dark" || preference === "solarized-light" || preference === "monokai"
    ? `codedock-${preference}`
    : theme === "light" ? LIGHT_THEME : DARK_THEME;
}

let themeRegistered = false;

export function setupMonacoTheme() {
  if (themeRegistered) return;
  themeRegistered = true;

  monaco.editor.defineTheme(DARK_THEME, {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#0f1115",
      "editor.foreground": "#d7dce5",
      "editorGutter.background": "#0f1115",
      "editorLineNumber.foreground": "#3d4553",
      "editorLineNumber.activeForeground": "#8b93a3",
      "editor.selectionBackground": "#2c3445",
      "editor.lineHighlightBackground": "#161a21",
      "editorCursor.foreground": "#6ea8fe",
      "editorIndentGuide.background1": "#1e232c",
      "editorWidget.background": "#161a21",
      "editorWidget.border": "#242a35",
      "scrollbarSlider.background": "#2a313d80",
      "scrollbarSlider.hoverBackground": "#39414f80",
      "scrollbarSlider.activeBackground": "#39414faa",
      "minimap.background": "#0f1115",
    },
  });

  // 浅色这套跟 styles.css 里的 --c-* 浅色值对齐，保证编辑器跟外面的面板同一个调子
  monaco.editor.defineTheme(LIGHT_THEME, {
    base: "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#ffffff",
      "editor.foreground": "#1f2430",
      "editorGutter.background": "#ffffff",
      "editorLineNumber.foreground": "#a9b3c0",
      "editorLineNumber.activeForeground": "#4a5261",
      "editor.selectionBackground": "#cfdffb",
      "editor.lineHighlightBackground": "#f4f6f9",
      "editorCursor.foreground": "#2563eb",
      "editorIndentGuide.background1": "#e6e9ee",
      "editorWidget.background": "#f6f7f9",
      "editorWidget.border": "#dfe3e9",
      "scrollbarSlider.background": "#c9cfd880",
      "scrollbarSlider.hoverBackground": "#aeb6c280",
      "scrollbarSlider.activeBackground": "#aeb6c2aa",
      "minimap.background": "#ffffff",
    },
  });

  const palettes = {
    vscode: ["vs-dark", "#1f1f1f", "#cccccc", "#252526", "#3794ff", "#04395e"],
    "vscode-light": ["vs", "#ffffff", "#333333", "#f8f8f8", "#006ab1", "#d6ebff"],
    "one-dark": ["vs-dark", "#282c34", "#abb2bf", "#2c313a", "#61afef", "#334255"],
    dracula: ["vs-dark", "#282a36", "#f8f8f2", "#303241", "#bd93f9", "#44475a"],
    "github-dark": ["vs-dark", "#0d1117", "#e6edf3", "#161b22", "#58a6ff", "#16345a"],
    "github-light": ["vs", "#ffffff", "#1f2328", "#f6f8fa", "#0969da", "#ddf4ff"],
    "material-nova": ["vs-dark", "#232936", "#d8dee9", "#292e39", "#82aaff", "#344052"],
    "neon-green": ["vs-dark", "#0e1813", "#d9ffe2", "#122019", "#39ff88", "#174d32"],
    "tokyo-night": ["vs-dark", "#1a1b26", "#c0caf5", "#1f2335", "#7aa2f7", "#283457"],
    "catppuccin-mocha": ["vs-dark", "#1e1e2e", "#cdd6f4", "#252537", "#cba6f7", "#3e3358"],
    nord: ["vs-dark", "#2e3440", "#d8dee9", "#3b4252", "#8fbcbb", "#3b5878"],
    "solarized-dark": ["vs-dark", "#002b36", "#93a1a1", "#073642", "#268bd2", "#10485f"],
    "solarized-light": ["vs", "#fdf6e3", "#073642", "#f2ecda", "#268bd2", "#d6e8f2"],
    monokai: ["vs-dark", "#272822", "#f8f8f2", "#31322b", "#66d9ef", "#3a4a4a"],
  } as const;
  for (const [name, [base, background, foreground, raised, accent, selection]] of Object.entries(palettes)) {
    monaco.editor.defineTheme(`codedock-${name}`, {
      base, inherit: true, rules: [],
      colors: {
        "editor.background": background,
        "editor.foreground": foreground,
        "editorGutter.background": background,
        "editorLineHighlightBackground": raised,
        "editorCursor.foreground": accent,
        "editor.selectionBackground": selection,
        "editorWidget.background": raised,
        "minimap.background": background,
      },
    });
  }
}

setupMonacoTheme();
// 注册 json5 / jsonc 语言与格式化器。放模块顶层：EditorPane 会先 import 本模块，
// 保证任何 createModel 之前语言已经就位
registerJsonLikeLanguages();

export { monaco };
