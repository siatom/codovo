import React from "react";
import ReactDOM from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import App from "./App";
import { SettingsProvider } from "./lib/settings";
import { ThemeProvider, applyTheme, readSavedTheme, resolveTheme } from "./lib/theme";

// 首帧渲染前先把主题落到 <html> 上，否则会先闪一下深色
applyTheme(resolveTheme(readSavedTheme()));

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider>
      <SettingsProvider>
        <App />
      </SettingsProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
