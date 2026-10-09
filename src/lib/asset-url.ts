import { convertFileSrc } from "@tauri-apps/api/core";

/**
 * asset 协议的地址。**不能直接用 `convertFileSrc`**：它把整条路径当成一个段来百分号编码，
 * 连分隔符一起编码掉（`D%3A%5CUsers%5C…`），于是 iframe 里相对路径的 css / js / 图片
 * 全按「最后一个段」来解析，落到根上变成 404。这里保留 `/` 当分隔符、只逐段编码，
 * 相对路径才接得上（asset 协议那边只认解码后的整条路径，两种写法都收）。
 *
 * 基址借 `convertFileSrc` 探出来（Windows 是 `http://asset.localhost/`，
 * macOS / Linux 是 `asset://localhost/`），免得自己按平台拼。
 *
 * 内置浏览器（`BrowserPane`）与编辑器内的 html / svg 预览（`HtmlPreview`）共用这一份。
 */
export function assetUrl(path: string): string {
  const probe = convertFileSrc("x");
  const base = probe.slice(0, -1);
  const segments = path.split(/[\\/]+/).filter(Boolean).map(encodeURIComponent);
  return base + segments.join("/");
}
