import type { ToolId } from "./ToolPane";
import { IconBranch, IconFile, IconGlobe, IconSearch } from "./icons";

/** 和左侧栏收起时同宽，两条竖栏看起来才是一套 */
const RAIL = "flex h-full w-11 shrink-0 flex-col items-center gap-1 border-r border-line bg-panel py-2";

// relative 是给「变更」角标定位用的，放在这行省得每个按钮各写一遍
const BUTTON =
  "relative flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-fg-dim hover:bg-hover hover:text-fg";

const BUTTON_ON = "bg-selected text-fg";

const BUTTON_OFF = "cursor-not-allowed text-fg-faint";

/**
 * 右边栏的模块注册表：顺序就是图标条上从上到下的顺序。
 * 设置里「右栏」那一页的显隐开关也照这份表来，加模块时两处不会走散。
 */
export const RIGHT_TOOLS: { id: ToolId; label: string; Icon: typeof IconFile }[] = [
  { id: "files", label: "文件", Icon: IconFile },
  { id: "search", label: "搜索", Icon: IconSearch },
  { id: "changes", label: "变更", Icon: IconBranch },
  { id: "browser", label: "浏览器", Icon: IconGlobe },
];

interface ToolRailProps {
  active: ToolId;
  /** 目录不是仓库时「变更」没有内容可看 */
  gitReady: boolean;
  /** 改动条目数；「变更」图标上的角标就取它 */
  changed: number;
  /** 设置里关掉的模块不上图标条 */
  visible: Record<ToolId, boolean>;
  onPick: (id: ToolId) => void;
}

/** 角标数字的上限，再多就写成 99+，否则图标条装不下 */
const BADGE_MAX = 99;

/**
 * 右边栏最左侧的图标条：切换各个模块。
 * 整个右边栏的收放由终端右上角那个按钮负责，这里只管切模块。
 */
export function ToolRail({ active, gitReady, changed, visible, onPick }: ToolRailProps) {
  return (
    <div className={RAIL}>
      {RIGHT_TOOLS.filter((tool) => visible[tool.id]).map(({ id, label, Icon }) => {
        // 不是仓库时「变更」点了也没内容可看，置灰而不是藏起来，免得用户以为模块没了
        const blocked = id === "changes" && !gitReady;
        // 有改动时才挂角标，0 就不显示——空白角标反而像加载失败
        const badge =
          id === "changes" && !blocked && changed > 0
            ? changed > BADGE_MAX
              ? `${BADGE_MAX}+`
              : String(changed)
            : null;
        return (
          <button
            key={id}
            type="button"
            onClick={() => onPick(id)}
            disabled={blocked}
            title={blocked ? "当前目录不是 git 仓库" : label}
            className={`${BUTTON} ${active === id ? BUTTON_ON : blocked ? BUTTON_OFF : ""}`}
          >
            <Icon />
            {badge && (
              <span className="pointer-events-none absolute -top-0.5 -right-0.5 min-w-[13px] rounded-full bg-accent px-1 text-center text-[9px] leading-[13px] font-medium text-app tabular-nums">
                {badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
