import { assetUrl } from "../lib/asset-url";

interface PdfPreviewProps {
  /** 磁盘上的真实路径。asset 协议只认磁盘，PDF 也不能在应用里编辑 */
  path: string;
}

/**
 * 只读的 PDF 预览：iframe 直接指向 asset 协议上的文件，交给 WebView 内置的 PDF
 * 阅读器渲染——WebView2（Chromium）与 WKWebView 都自带，翻页 / 缩放 / 文本选择
 * 一并可用，**零依赖**，不引 pdf.js。
 *
 * 与 html / svg 预览（`HtmlPreview`）同一套：都走 asset 协议。区别是那边读的是
 * 可编辑的磁盘文件、保存后要换 nonce 重载；PDF 在应用里改不了，`key` 跟着路径走
 * 就够了——切到别的标签会卸载，切回来重新挂载即重新加载。
 *
 * asset 协议按扩展名推断 Content-Type，`.pdf` 会得到 `application/pdf`，WebView
 * 才会用内置阅读器打开；若给成 octet-stream 就变成下载了。
 */
export function PdfPreview({ path }: PdfPreviewProps) {
  return (
    <iframe
      key={path}
      src={assetUrl(path)}
      title="PDF 预览"
      className="absolute inset-0 h-full w-full border-0 bg-surface"
    />
  );
}
