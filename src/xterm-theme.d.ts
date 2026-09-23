/** xterm-theme 是个 UMD 包、不带类型声明：导出名 -> xterm 配色对象 */
declare module "xterm-theme" {
  import type { ITheme } from "@xterm/xterm";

  const themes: Record<string, ITheme>;
  export default themes;
}
