import { assetUrl } from "../lib/asset-url";

interface HtmlPreviewProps {
  /** 磁盘上的真实路径。预览读的是**已保存**的文件——asset 协议只认磁盘 */
  path: string;
  /** 变一次就重新加载（保存后再预览要拿到新内容） */
  nonce: number;
}

/**
 * 只读的 html / svg 预览：iframe 直接加载工作区里的文件，走 asset 协议，
 * 相对路径引用的 css / js / 图片一并生效（和右栏「浏览器」模块同一套）。
 *
 * 与 markdown 预览的区别：markdown 从 model 现渲染、能实时反映未保存的改动；
 * 这里读的是磁盘，所以调用方进入预览前会先把文件落盘（见 EditorPane 的 togglePreview）。
 */
export function HtmlPreview({ path, nonce }: HtmlPreviewProps) {
  // 挂一个随 nonce 变的查询串：asset 协议自己不发 Cache-Control，保存后重新预览
  // 不能让 WebView 的缓存把旧的一版顶回来。查询串不影响相对路径解析，asset 也只认路径。
  return (
    <iframe
      key={nonce}
      src={`${assetUrl(path)}?t=${nonce}`}
      title="预览"
      className="absolute inset-0 h-full w-full border-0 bg-white"
    />
  );
}
