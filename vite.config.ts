import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
// @ts-expect-error type error without @types/node package
import process from "node:process";
// @ts-expect-error type error without @types/node package
import { readFileSync } from "node:fs";

const host = process.env.TAURI_DEV_HOST;

/**
 * 版本号只有一个来源：package.json——`tauri.conf.json` 的 `version` 也指向它，
 * 所以安装包文件名、exe 的版本资源和界面里显示的必然是同一个值。
 * 编译期注入，省得为了读版本再单开一个 Tauri 权限。
 */
const version = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
).version as string;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],

  define: {
    __APP_VERSION__: JSON.stringify(version),
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  // 刻意不用 Tauri 模板默认的 1420：那个端口是所有 Tauri 项目共用的默认值，
  // 本机同时跑第二个 Tauri 应用就会撞端口（strictPort 下直接起不来）。5273 只是
  // 一个没人占的高位段，没有别处引用它；改这里要同步 tauri.conf.json 的 devUrl。
  server: {
    port: 5273,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 5274,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    // WebView2 / WKWebView 都支持到这个版本
    target: "chrome110",
    sourcemap: false,
  },
}));
