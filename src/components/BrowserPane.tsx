import { useCallback, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { FullscreenButton } from "./FullscreenButton";
import { IconExternalLink, IconRefresh } from "./icons";

const URL_KEY = "codedock.browserUrl";

/**
 * 记住上次的地址：右栏会记住停在哪个模块，回来时地址栏空着很别扭。
 * 用 sessionStorage：地址是窗口级的，两个窗口各预览各的本地服务。
 */
function readSavedUrl(): string {
  try {
    return window.sessionStorage.getItem(URL_KEY) ?? "";
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
 * 右栏的「浏览器」模块：用 iframe 内嵌页面，主要用来预览跑在终端里的本地服务。
 * 跨域站点拿不到 iframe 内部的地址，所以地址栏只认用户输入，不跟着页面内部跳转走；
 * 「刷新」是重挂 iframe，页面自己跳转到哪了会被拉回地址栏里那个地址。
 */
export function BrowserPane({
  fullscreen,
  onToggleFullscreen,
}: {
  fullscreen: boolean;
  onToggleFullscreen: () => void;
}) {
  const [url, setUrl] = useState(readSavedUrl);
  const [draft, setDraft] = useState(url);
  /** 变一次就重挂 iframe，等于刷新 */
  const [nonce, setNonce] = useState(0);

  const commit = useCallback((raw: string) => {
    const next = toUrl(raw);
    if (!next) return;
    setUrl(next);
    setDraft(next);
    setNonce((count) => count + 1);
    try {
      window.sessionStorage.setItem(URL_KEY, next);
    } catch {
      // 记不住不影响用
    }
  }, []);

  // 拒绝被嵌入的站点在 iframe 里就是一片空白，给它留个出口
  const openExternal = useCallback(() => {
    void openUrl(url).catch(() => {
      // 系统浏览器没打开就算了，面板里的 iframe 还在
    });
  }, [url]);

  const HEAD_BUTTON =
    "flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-dim hover:bg-active hover:text-fg disabled:text-fg-faint disabled:hover:bg-transparent";

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
            src={url}
            title="浏览器"
            className="absolute inset-0 h-full w-full border-0 bg-white"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center px-6">
            <p className="max-w-[280px] text-center text-[12px] leading-relaxed text-fg-faint">
              在上面填地址回车即可预览。拒绝被嵌入的站点（X-Frame-Options）会显示空白。
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
