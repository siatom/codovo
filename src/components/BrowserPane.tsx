import { useCallback, useEffect, useState } from "react";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { assetUrl } from "../lib/asset-url";
import { FullscreenButton } from "./FullscreenButton";
import { IconExternalLink, IconRefresh } from "./icons";

const URL_KEY = "codedock.browserUrl.";

/**
 * 文件树里点了「在内置浏览器中打开」时送进来的请求。
 * `path` 是磁盘上的真实路径，`label` 是地址栏里显示的相对路径（比一长串绝对路径好认）。
 * nonce 每来一次加一，保证连点同一个文件也会重新加载。
 */
export interface BrowserFileRequest {
  path: string;
  label: string;
  nonce: number;
}

/**
 * 记住上次的地址：右栏会记住停在哪个模块，回来时地址栏空着很别扭。
 * key 带上工作区 root：多个工作区各预览各的本地服务，切工作区时地址跟着换。
 */
function readSavedUrl(root: string): string {
  try {
    return window.sessionStorage.getItem(URL_KEY + root) ?? "";
  } catch {
    return "";
  }
}

/**
 * 用户敲的是「3000」「localhost:5173」这种片段，这里补成完整 URL。
 * 认不出来的一律当本机端口——这个面板就是用来预览本地服务的，猜错成外网域名反而更费事。
 */
function toUrl(raw: string): string {
  const text = raw.trim();
  if (!text) return "";
  if (/^(https?|file):\/\//i.test(text)) return text;
  // 纯数字就是端口
  if (/^\d+$/.test(text)) return `http://localhost:${text}`;
  // 本机地址只缺协议
  if (/^(localhost|127\.0\.0\.1|\[::1\])([:/]|$)/i.test(text)) return `http://${text}`;
  // 带点的当域名，同样只缺协议
  if (/^[^/?#]+\.[^/?#]+/.test(text)) return `http://${text}`;
  return `http://localhost:${text}`;
}

/**
 * 右栏的「浏览器」模块：用 iframe 内嵌页面，主要用来预览跑在终端里的本地服务，
 * 也可以从文件树右键把工作区里的网页文件（html / htm / svg）丢进来预览。
 * 跨域站点拿不到 iframe 内部的地址，所以地址栏只认用户输入，不跟着页面内部跳转走；
 * 「刷新」是重挂 iframe，页面自己跳转到哪了会被拉回地址栏里那个地址。
 */
export function BrowserPane({
  root,
  request,
  fullscreen,
  onToggleFullscreen,
}: {
  /** 地址按工作区各记一份：切工作区时看到的是各自上次预览的那个地址 */
  root: string;
  /** 文件树送来的「打开这个文件」，null = 没有 */
  request: BrowserFileRequest | null;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
}) {
  const [url, setUrl] = useState(() => readSavedUrl(root));
  const [draft, setDraft] = useState(url);
  /** 变一次就重挂 iframe，等于刷新 */
  const [nonce, setNonce] = useState(0);
  /**
   * 当前预览的是工作区里的哪个文件。非空时地址栏里是文件相对路径而不是 URL，
   * 「用系统浏览器打开」也得换成拿真实路径去开——asset 地址只在这个 webview 里认。
   */
  const [filePath, setFilePath] = useState<string | null>(null);

  // 文件树点了「在内置浏览器中打开」。request 每次都是新对象（带新 nonce），
  // 所以连点同一个文件也会重新加载一次
  useEffect(() => {
    if (!request) return;
    setUrl(assetUrl(request.path));
    setDraft(request.label);
    setFilePath(request.path);
    setNonce((count) => count + 1);
  }, [request]);

  const commit = useCallback((raw: string) => {
    const next = toUrl(raw);
    if (!next) return;
    setUrl(next);
    setDraft(next);
    // 地址栏里敲了新地址就是回到「预览本地服务」，不再当某个文件在预览
    setFilePath(null);
    setNonce((count) => count + 1);
    try {
      window.sessionStorage.setItem(URL_KEY + root, next);
    } catch {
      // 记不住不影响用
    }
  }, [root]);

  // 拒绝被嵌入的站点在 iframe 里就是一片空白，给它留个出口
  const openExternal = useCallback(() => {
    // 文件走系统默认程序：asset 地址只在这个 webview 里有效，丢给系统浏览器打不开
    const target = filePath;
    void (target ? openPath(target) : openUrl(url)).catch(() => {
      // 没打开就算了，面板里的 iframe 还在
    });
  }, [filePath, url]);

  const HEAD_BUTTON =
    "flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-dim hover:bg-active hover:text-fg disabled:text-fg-faint disabled:hover:bg-transparent";

  // 预览文件时给地址挂一个随 nonce 变的查询串：改完文件点「重新加载」要拿到新内容，
  // 不能让 WebView 的缓存把旧的一版顶回来（asset 协议自己不发 Cache-Control）。
  // 查询串不影响相对路径的解析，asset 协议也只认路径、不看查询。
  const src = filePath ? `${url}?t=${nonce}` : url;

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-surface">
      <header className="flex h-8 shrink-0 items-center gap-1 border-b border-line px-2">
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit(draft);
          }}
          placeholder="输入本地服务地址，如 5173 或 localhost:3000"
          spellCheck={false}
          className="h-6 min-w-0 flex-1 rounded border border-line-strong bg-surface px-2 text-[12px] text-fg outline-none placeholder:text-fg-faint focus:border-accent"
        />
        <button
          type="button"
          onClick={() => setNonce((count) => count + 1)}
          disabled={!url}
          title="重新加载"
          className={HEAD_BUTTON}
        >
          <IconRefresh className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={openExternal}
          disabled={!url}
          title="用系统浏览器打开"
          className={HEAD_BUTTON}
        >
          <IconExternalLink className="h-3.5 w-3.5" />
        </button>
        <FullscreenButton fullscreen={fullscreen} onToggle={onToggleFullscreen} />
      </header>

      <div className="relative min-h-0 flex-1">
        {url ? (
          // 页面多半是按白底设计的，深色主题下不给个白底会透出面板色
          <iframe
            key={nonce}
            src={src}
            title="浏览器"
            className="absolute inset-0 h-full w-full border-0 bg-white"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center px-6">
            <p className="max-w-[280px] text-center text-[12px] leading-relaxed text-fg-faint">
              在上面填地址回车即可预览本地服务，也可以从文件树右键网页文件在这里打开。
              拒绝被嵌入的站点（X-Frame-Options）会显示空白。
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
