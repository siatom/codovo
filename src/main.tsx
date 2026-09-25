import React from "react";
import ReactDOM from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import App from "./App";
import { SettingsProvider } from "./lib/settings";
import { ThemeProvider, applyTheme, readSavedTheme, resolveTheme } from "./lib/theme";

// 首帧渲染前先把主题落到 <html> 上，否则会先闪一下深色
applyTheme(resolveTheme(readSavedTheme()));

// 默认屏蔽 WebView 的原生右键菜单（「刷新/检查/复制」那一套）：界面里只有文件树节点
// 自己画了菜单，它会先在 handler 里 preventDefault。所以这里放行 defaultPrevented 的事件、
// 其余一律挡掉——等价于「只有明确声明了右键菜单的地方才弹，别处右键不响应」。
// 用冒泡阶段挂在 document 上：React 的委托在 #root 先跑，到这里才看得到它的 preventDefault。
document.addEventListener("contextmenu", (event) => {
  if (!event.defaultPrevented) event.preventDefault();
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider>
      <SettingsProvider>
        <App />
      </SettingsProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
