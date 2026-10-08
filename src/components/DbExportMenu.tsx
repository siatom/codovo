import { useEffect, useRef, useState } from "react";
import type { DbExportFormat, DbExportScope } from "../lib/database";
import { IconChevronDown, IconDownload } from "./icons";

interface DbExportMenuProps {
  /** 触发导出。取数 / 保存对话框 / 后端调用都由调用方负责，这里只管「选」 */
  onExport: (format: DbExportFormat, scope: DbExportScope) => void;
  disabled?: boolean;
  /** 导出进行中：按钮显示「导出中…」并禁用 */
  busy?: boolean;
  /** 默认选中的范围，默认「当前页」 */
  defaultScope?: DbExportScope;
  /** 菜单水平对齐：右对齐（贴按钮右缘，默认）或左对齐 */
  align?: "left" | "right";
}

/** 菜单宽度写死，用来贴窗口边缘收一收位置 */
const MENU_W = 168;
/**
 * 菜单高度估算（段选一行 + 两个格式项 + 间隙与内边距），用来判断下方放不放得下。
 * 取值略大于实测，宁高勿低——高了顶多提前翻转，低了就会探出视口。
 */
const MENU_H = 104;

const ITEM =
  "flex w-full items-center rounded px-2 py-1 text-left text-[12px] text-fg-muted hover:bg-hover hover:text-fg";
const SEGMENT = "flex-1 rounded px-2 py-0.5 text-[11px]";

/**
 * 「导出」下拉：先选范围（当前页 / 全部），再选格式（CSV / Excel）。
 * 结果区工具条与表节点右键共用同一套交互，所以抽成组件；它不做 invoke，
 * 真正的取数与写盘交给 onExport，保持各调用方的会话 / SQL 上下文不外泄。
 */
export function DbExportMenu({
  onExport,
  disabled,
  busy,
  defaultScope = "page",
  align = "right",
}: DbExportMenuProps) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<DbExportScope>(defaultScope);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);

  // 菜单开着时任何滚动都把它收起来：它 fixed 定位，滚动后会浮在原地
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("scroll", close, true);
    return () => window.removeEventListener("scroll", close, true);
  }, [open]);

  const toggle = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      const wanted = align === "right" ? rect.right - MENU_W : rect.left;
      // 结果区的导出按钮贴在窗口底部，向下展开会整个探出视口外——下方放不下就翻到按钮上方
      const below = rect.bottom + 4;
      setPos({
        left: Math.max(4, Math.min(wanted, window.innerWidth - MENU_W - 4)),
        top: below + MENU_H > window.innerHeight - 4 ? Math.max(4, rect.top - MENU_H - 4) : below,
      });
    }
    setOpen((value) => !value);
  };

  const pick = (format: DbExportFormat) => {
    setOpen(false);
    onExport(format, scope);
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled || busy}
        onClick={toggle}
        title="导出结果"
        className="flex items-center gap-1 rounded border border-line-strong px-2 py-0.5 text-[11px] text-fg-muted hover:bg-hover hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent"
      >
        <IconDownload className="h-3 w-3" />
        {busy ? "导出中…" : "导出"}
        <IconChevronDown className="h-3 w-3" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div
            className="fixed z-40 flex flex-col gap-1 rounded-lg border border-line-strong bg-raised p-1 shadow-lg"
            style={{ width: MENU_W, left: pos.left, top: pos.top }}
          >
            <div className="flex items-center gap-1 rounded border border-line-strong p-0.5">
              {(["page", "all"] as DbExportScope[]).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setScope(value)}
                  className={`${SEGMENT} ${
                    scope === value ? "bg-selected text-fg" : "text-fg-dim hover:bg-hover"
                  }`}
                >
                  {value === "page" ? "当前页" : "全部"}
                </button>
              ))}
            </div>
            <button type="button" className={ITEM} onClick={() => pick("csv")}>
              导出为 CSV
            </button>
            <button type="button" className={ITEM} onClick={() => pick("xlsx")}>
              导出为 Excel
            </button>
          </div>
        </>
      )}
    </>
  );
}
