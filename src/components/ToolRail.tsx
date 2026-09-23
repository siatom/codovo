import type { ToolId } from "./ToolPane";
import { IconBranch, IconFile, IconGlobe } from "./icons";

/** 和左侧栏收起时同宽，两条竖栏看起来才是一套 */
const RAIL = "flex h-full w-11 shrink-0 flex-col items-center gap-1 border-r border-line bg-panel py-2";

const BUTTON =
  "flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-fg-dim hover:bg-hover hover:text-fg";

const BUTTON_ON = "bg-selected text-fg";

const BUTTON_OFF = "cursor-not-allowed text-fg-faint";

interface ToolRailProps {
  active: ToolId;
  /** 目录不是仓库时「变更」没有内容可看 */
  gitReady: boolean;
  onPick: (id: ToolId) => void;
}

/**
 * 右边栏最左侧的图标条：切换「文件」/「变更」/「浏览器」。
 * 整个右边栏的收放由终端右上角那个按钮负责，这里只管切模块。
 */
export function ToolRail({ active, gitReady, onPick }: ToolRailProps) {
  return (
    <div className={RAIL}>
      <button
        type="button"
        onClick={() => onPick("files")}
        title="文件"
        className={`${BUTTON} ${active === "files" ? BUTTON_ON : ""}`}
      >
        <IconFile />
      </button>
      <button
        type="button"
        onClick={() => onPick("changes")}
        disabled={!gitReady}
        title={gitReady ? "变更" : "当前目录不是 git 仓库"}
        className={`${BUTTON} ${active === "changes" ? BUTTON_ON : gitReady ? "" : BUTTON_OFF}`}
      >
        <IconBranch />
      </button>
      <button
        type="button"
        onClick={() => onPick("browser")}
        title="浏览器"
        className={`${BUTTON} ${active === "browser" ? BUTTON_ON : ""}`}
      >
        <IconGlobe />
      </button>
    </div>
  );
}
