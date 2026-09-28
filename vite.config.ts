import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
// @ts-expect-error type error without @types/node package
import process from "node:process";
// @ts-expect-error type error without @types/node package
import { readFileSync } from "node:fs";
// @ts-expect-error type error without @types/node package
import { execSync } from "node:child_process";

const host = process.env.TAURI_DEV_HOST;

/**
 * 版本号只有一个来源：package.json——`tauri.conf.json` 的 `version` 也指向它，
 * 所以安装包文件名、exe 的版本资源和界面里显示的必然是同一个值。
 * 编译期注入，省得为了读版本再单开一个 Tauri 权限。
 */
const version = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
).version as string;

/**
 * 构建标识：`<短 hash>`，工作区有未提交改动就再缀个 `.dirty`。
 *
 * 版本号是**发布里程碑**、平时不动；这一串才是「这一次构建」的身份，用来回答
 * 「我装的到底是哪一次」。exe 的版本资源和安装包文件名**不带**它——Windows 那边
 * 只接受纯 `x.y.z`。
 */
function buildStamp(): string {
  const run = (cmd: string) =>
    execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    const hash = run("git rev-parse --short HEAD");
    return run("git status --porcelain") ? `${hash}.dirty` : hash;
  } catch {
    // 没装 git、或者不是从仓库构建的（比如解压 tarball）——退回不带标识
    return "";
  }
}

const stamp = buildStamp();

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],

  define: {
    __APP_VERSION__: JSON.stringify(stamp ? `${version}+${stamp}` : version),
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
