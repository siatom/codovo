import DOMPurify from "dompurify";
import { Marked } from "marked";

/**
 * 预览用的 markdown 渲染器。
 * async 必须显式关掉：异步模式下 parse 返回 Promise，这里要的是同步拿字符串。
 * gfm 本来就是默认值，写出来是为了说明表格、任务列表、删除线都支持。
 */
const md = new Marked({ async: false, gfm: true });

/**
 * 渲染成能直接交给 dangerouslySetInnerHTML 的 HTML。
 * 必须过一遍 DOMPurify：编辑的是本地文件，但内容不一定可信（clone 下来的 README 就是别人写的），
 * 里面塞一个 <img onerror> 就能在 WebView 里跑脚本。
 */
export function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(md.parse(text) as string);
}
