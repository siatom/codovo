import React from "react";
import ReactDOM from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
// KaTeX 的排版样式与字体随包一起打进前端，离线预览数学公式不依赖 CDN
import "katex/dist/katex.min.css";
import "./styles.css";
import App from "./App";
import { SettingsProvider } from "./lib/settings";
import { ThemeProvider, applyTheme, readSavedTheme, resolveTheme } from "./lib/theme";

// macOS 的原生红绿灯叠在窗口顶部；弹窗遮罩留出标题栏高度，避免遮暗或挡住窗口控件。
if (/Macintosh|Mac OS X/.test(navigator.userAgent)) {
  document.documentElement.classList.add("codovo-macos");
}

// 首帧渲染前先把主题落到 <html> 上，否则会先闪一下深色
applyTheme(resolveTheme(readSavedTheme()));

// 默认屏蔽 WebView 的原生右键菜单（「刷新/检查/复制」那一套）：界面里只有文件树节点
// 自己画了菜单，它会先在 handler 里 preventDefault。所以这里放行 defaultPrevented 的事件、
// 其余一律挡掉——等价于「只有明确声明了右键菜单的地方才弹，别处右键不响应」。
// 用冒泡阶段挂在 document 上：React 的委托在 #root 先跑，到这里才看得到它的 preventDefault。
document.addEventListener("contextmenu", (event) => {
  if (!event.defaultPrevented) event.preventDefault();
});

if (!import.meta.env.DEV) {
  // 正式版禁用浏览器快捷键，避免误触刷新、打印或打开开发者工具；开发版保留这些快捷键方便调试。
  document.addEventListener("keydown", (event) => {
    const key = event.key.toLowerCase();
    const primary = event.ctrlKey || event.metaKey;
    const reload = key === "r" && primary;
    const print = key === "p" && primary && !event.altKey;
    const devtools = key === "f12" || (key === "i" && primary && (event.shiftKey || event.altKey));
    if (key === "f5" || reload || print || devtools) {
      event.preventDefault();
    }
  });
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider>
      <SettingsProvider>
        <App />
      </SettingsProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
