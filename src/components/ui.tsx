import type { ButtonHTMLAttributes, ReactNode } from "react";

/**
 * 界面里的通用小控件。规则就三条：
 * - 图标字形只有三档：行内 / 标题栏 / 独立图标；
 * - 持久选中一律 `bg-selected`，临时反馈 `bg-active`，行悬停 `bg-hover`；
 * - 标题栏的图标按钮盒子 24px，列表行 20px，右栏图标条 32px。
 *
 * 以前这些样式散在各面板里各抄一份，改一处颜色要翻五六个文件；集中在这里之后，
 * 新面板直接组合，不用再复制 class 串。
 */

/** 图标字形尺寸：列表行等紧凑处用 XS，标题栏 / Tab 用 SM，右栏图标条用 MD */
export const ICON_XS = "h-3 w-3";
export const ICON_SM = "h-3.5 w-3.5";
export const ICON_MD = "h-4 w-4";

const BUTTON_SIZE = {
  /** 列表行、Tab 上的小按钮 */
  xs: "h-5 w-5",
  /** 面板标题栏 */
  sm: "h-6 w-6",
  /** 右侧图标条 */
  md: "h-8 w-8",
} as const;

const BUTTON_RADIUS = {
  sm: "rounded",
  md: "rounded-md",
} as const;

interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "aria-label"> {
  /** 图标的可读名称：同时用作 title 和 aria-label，需要不同时再传 title */
  label: string;
  /** 字形，一般传 `<IconX className={ICON_SM} />` */
  children: ReactNode;
  /** 持续选中态（当前模块 / 开关打开）；临时按下沿用 CSS 的 active */
  active?: boolean;
  /** 关闭、删除这类危险动作 */
  tone?: "default" | "danger";
  size?: keyof typeof BUTTON_SIZE;
  radius?: keyof typeof BUTTON_RADIUS;
}

export function IconButton({
  label,
  children,
  active = false,
  tone = "default",
  size = "sm",
  radius = "sm",
  title,
  className = "",
  ...rest
}: IconButtonProps) {
  const color = active
    ? "bg-selected text-fg"
    : tone === "danger"
      ? "text-fg-faint hover:bg-hover hover:text-danger"
      : "text-fg-dim hover:bg-active hover:text-fg";
  return (
    <button
      type="button"
      {...rest}
      title={title ?? label}
      aria-label={label}
      aria-pressed={active || undefined}
      className={`flex shrink-0 items-center justify-center ${BUTTON_SIZE[size]} ${BUTTON_RADIUS[radius]} ${color} disabled:text-fg-faint disabled:hover:bg-transparent ${className}`}
    >
      {children}
    </button>
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label?: string;
  title?: string;
  icon?: ReactNode;
  /** 数字角标（如工作树 / 分支数量） */
  count?: number;
  /** 需要提醒的数字（等用户处理的数量） */
  alert?: number;
  disabled?: boolean;
}

interface SegmentedProps<T extends string> {
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  /** 分组名称，给读屏用 */
  label: string;
  className?: string;
}

/**
 * 分段切换（工作树 / 分支、终端 / 文件、终端 / ACP 对话）。
 * 选中态用 bg-selected——和右边的图标条、超级 Tab 保持同一套语义。
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  className = "",
}: SegmentedProps<T>) {
  return (
    <div
      role="group"
      aria-label={label}
      className={`flex items-center gap-0.5 rounded-md border border-line bg-surface p-0.5 ${className}`}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            disabled={option.disabled}
            title={option.title}
            aria-pressed={active}
            className={`flex min-w-0 flex-1 items-center justify-center gap-1 rounded px-2 py-[3px] text-[11px] ${
              active ? "bg-selected text-fg" : "text-fg-dim hover:text-fg"
            } disabled:cursor-not-allowed disabled:opacity-40`}
          >
            {option.icon}
            {option.label !== undefined && <span className="truncate">{option.label}</span>}
            {typeof option.count === "number" && (
              <span
                className={`shrink-0 text-[10px] tabular-nums ${
                  active ? "text-fg-muted" : "text-fg-faint"
                }`}
              >
                {option.count}
              </span>
            )}
            {option.alert ? (
              <span className="shrink-0 rounded-full bg-warn px-1 text-[9px] leading-[14px] font-medium text-app tabular-nums">
                {option.alert}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export type StatusTone = "idle" | "off" | "busy" | "ok" | "error";

const STATUS_DOT_TONE: Record<StatusTone, string> = {
  idle: "bg-fg-faint",
  off: "bg-line-strong",
  busy: "bg-warn animate-pulse",
  ok: "bg-accent",
  error: "bg-danger",
};

/** 列表行 / 面板标题里的状态点：尺寸只有两档，颜色按语义取 */
export function StatusDot({
  tone = "idle",
  size = "sm",
  title,
  className = "",
}: {
  tone?: StatusTone;
  size?: "sm" | "md";
  title?: string;
  className?: string;
}) {
  return (
    <span
      className={`${size === "md" ? "h-2 w-2" : "h-1.5 w-1.5"} shrink-0 rounded-full ${STATUS_DOT_TONE[tone]} ${className}`}
      title={title}
    />
  );
}
