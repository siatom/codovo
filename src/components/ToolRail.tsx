import type { MouseEvent as ReactMouseEvent } from "react";
import type { ToolId } from "./ToolPane";
import {
  IconBranch,
  IconDatabase,
  IconFile,
  IconGlobe,
  IconPanelRight,
  IconPanelRightOpen,
  IconPlay,
  IconSearch,
  IconServer,
} from "./icons";

/** 和左侧栏收起时同宽，两条竖栏看起来才是一套。
    不画右边框：整块界面靠背景深浅区分，没有常驻竖线。
    背景用 --c-panel，跟左侧栏完全同色——两边竖栏是一套；
    挨着的内容面板用 --c-content 略浅一档，靠这点差把图标栏和内容分开。 */
const RAIL = "flex h-full w-11 shrink-0 flex-col items-center gap-1 bg-panel py-2";

// relative 是给「变更」角标定位用的，放在这行省得每个按钮各写一遍
const BUTTON =
  "relative flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-fg-dim hover:bg-hover hover:text-fg";

const BUTTON_ON = "bg-selected text-fg";

/**
 * 右边栏的模块注册表：顺序就是图标条上从上到下的顺序。
 * 设置里「右栏」那一页的显隐开关也照这份表来，加模块时两处不会走散。
 */
export const RIGHT_TOOLS: { id: ToolId; label: string; Icon: typeof IconFile }[] = [
  { id: "files", label: "文件", Icon: IconFile },
  { id: "search", label: "搜索", Icon: IconSearch },
  { id: "changes", label: "变更", Icon: IconBranch },
  { id: "browser", label: "浏览器", Icon: IconGlobe },
  { id: "remote", label: "远程连接", Icon: IconServer },
  { id: "database", label: "数据库", Icon: IconDatabase },
  { id: "preview", label: "预览", Icon: IconPlay },
];

interface ToolRailProps {
  active: ToolId;
  /** 改动条目数；「变更」图标上的角标就取它 */
  changed: number;
  /** 设置里关掉的模块不上图标条 */
  visible: Record<ToolId, boolean>;
  onPick: (id: ToolId) => void;
  /** 内容面板是否展开，决定底部那个收放按钮的图标方向 */
  rightOpen: boolean;
  /** 收放按钮沉在图标条最下面，和左侧栏的收起按钮同一个位置 */
  onToggleRight: () => void;
  /** 点图标条上的空白处：切整条右边栏的显隐，和左侧栏一个手感 */
  onBlankClick: (event: ReactMouseEvent<HTMLDivElement>) => void;
}

/** 角标数字的上限，再多就写成 99+，否则图标条装不下 */
const BADGE_MAX = 99;

/**
 * 右边栏最左侧的图标条：切换各个模块，底部收放整条右边栏的内容面板。
 */
export function ToolRail({
  active,
  changed,
  visible,
  onPick,
  rightOpen,
  onToggleRight,
  onBlankClick,
}: ToolRailProps) {
  return (
    <div className={RAIL} onClick={onBlankClick}>
      {RIGHT_TOOLS.filter((tool) => visible[tool.id]).map(({ id, label, Icon }) => {
        // 有改动时才挂角标，0 就不显示——空白角标反而像加载失败
        const badge =
          id === "changes" && changed > 0
            ? changed > BADGE_MAX
              ? `${BADGE_MAX}+`
              : String(changed)
            : null;
        return (
          <button
            key={id}
            type="button"
            onClick={() => onPick(id)}
            title={label}
            className={`${BUTTON} ${active === id ? BUTTON_ON : ""}`}
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

      {/* mt-auto 把它顶到底部，和左侧栏的收起按钮一条水平线 */}
      <button
        type="button"
        onClick={onToggleRight}
        title={rightOpen ? "收起右侧面板" : "展开右侧面板"}
        className={`${BUTTON} mt-auto`}
      >
        {rightOpen ? <IconPanelRightOpen /> : <IconPanelRight />}
      </button>
    </div>
  );
}
