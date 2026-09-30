import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
} from "react";
import {
  useSettings,
  FONT_SIZE_MIN,
  FONT_SIZE_MAX,
  AUTOSAVE_DELAY_MIN,
  AUTOSAVE_DELAY_MAX,
  DEFAULT_MONO_FONT,
  type AgentLayer,
  type AgentProfile,
  type AgentSkill,
  type AiProvider,
  type AutoSaveMode,
  type ProviderModel,
  type Settings,
} from "../lib/settings";
import {
  isValidAgentName,
  projectLayer,
  withLayer,
} from "../lib/agent-profiles";
import {
  emptyModel,
  emptyProvider,
  modelRef,
  modelRefOptions,
  newProviderId,
  resolveDefaultModel,
} from "../lib/providers";
import {
  TERMINAL_THEME_OPTIONS,
  resolveTerminalTheme,
} from "../lib/terminal-themes";
import { useTheme, DEFAULT_THEME, type ResolvedTheme, type Theme } from "../lib/theme";
import { listShells } from "../lib/pty";
import {
  listProviderModels,
  testProviderConnection,
  useDevAiOverrides,
  type RemoteModel,
} from "../lib/ai";
import { deleteSecret, setSecret } from "../lib/secrets";
import {
  checkDependencies,
  installDependency,
  type DependencyStatus,
} from "../lib/installer";
import { RIGHT_TOOLS } from "./ToolRail";
import type { ToolId } from "./ToolPane";
import { ConfirmDialog } from "./ConfirmDialog";
import { IconCheck, IconChevronDown, IconClose, IconCopy, IconDownload, IconPlus } from "./icons";

interface SettingsDialogProps {
  onClose: () => void;
  /** 当前工作区路径；「智能体」分类的项目层按它分桶，没开工作区时为 null */
  cwd?: string | null;
}

/** 分类靠左边的竖排 tab，内容区一次只显示一组 */
const TABS = [
  { id: "appearance", label: "外观" },
  { id: "terminal", label: "终端" },
  { id: "editor", label: "编辑器" },
  { id: "agent", label: "智能体" },
  { id: "dependencies", label: "依赖" },
] as const;

type TabId = (typeof TABS)[number]["id"];

/** 下拉里的双色圆点用 [背景, 前景]，跟 styles.css / monaco 里那套色值对齐 */
const THEME_OPTIONS: { value: Theme; label: string; swatch: [string, string] }[] = [
  { value: "dark", label: "深色", swatch: ["#0f1115", "#d7dce5"] },
  { value: "light", label: "浅色", swatch: ["#ffffff", "#1f2430"] },
  { value: "system", label: "跟随系统", swatch: ["#0f1115", "#eef0f3"] },
  { value: "vscode", label: "VS Code Dark", swatch: ["#1f1f1f", "#cccccc"] },
  { value: "vscode-light", label: "VS Code Light", swatch: ["#ffffff", "#333333"] },
  { value: "one-dark", label: "One Dark", swatch: ["#282c34", "#abb2bf"] },
  { value: "dracula", label: "Dracula", swatch: ["#282a36", "#f8f8f2"] },
  { value: "github-dark", label: "GitHub Dark", swatch: ["#0d1117", "#e6edf3"] },
  { value: "github-light", label: "GitHub Light", swatch: ["#ffffff", "#1f2328"] },
  { value: "material-nova", label: "Material Nova", swatch: ["#1f2430", "#d8dee9"] },
  { value: "neon-green", label: "Neon Green", swatch: ["#0b1210", "#d9ffe2"] },
  { value: "tokyo-night", label: "Tokyo Night", swatch: ["#1a1b26", "#c0caf5"] },
  { value: "catppuccin-mocha", label: "Catppuccin Mocha", swatch: ["#1e1e2e", "#cdd6f4"] },
  { value: "nord", label: "Nord", swatch: ["#2e3440", "#d8dee9"] },
  { value: "solarized-light", label: "Solarized Light", swatch: ["#fdf6e3", "#073642"] },
  { value: "monokai", label: "Monokai", swatch: ["#272822", "#f8f8f2"] },
];

const WEIGHT_OPTIONS: { value: boolean; label: string }[] = [
  { value: false, label: "正常" },
  { value: true, label: "加粗" },
];

const VISIBLE_OPTIONS: { value: boolean; label: string }[] = [
  { value: true, label: "展示" },
  { value: false, label: "隐藏" },
];

/** 开着项目时关窗口：直接收进托盘，还是每次都问一句 */
const CLOSE_OPTIONS: { value: boolean; label: string }[] = [
  { value: false, label: "每次询问" },
  { value: true, label: "收进托盘" },
];

/** 时机名字跟 VS Code 的 files.autoSave 对齐 */
const AUTO_SAVE_OPTIONS: { value: AutoSaveMode; label: string }[] = [
  { value: "off", label: "关闭" },
  { value: "afterDelay", label: "延迟后" },
  { value: "onFocusChange", label: "焦点离开编辑器时" },
  { value: "onWindowChange", label: "窗口失焦时" },
];

const TEXT_INPUT =
  "w-full rounded-md border border-line-strong bg-surface px-2 py-1 text-[12px] text-fg outline-none focus:border-accent";

const LIST_ACTION =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-faint hover:bg-hover hover:text-danger";

/** 分组标题右端的行内操作按钮，和列表里的删除按钮同一套视觉 */
const HEAD_ACTION =
  "flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-faint hover:bg-hover hover:text-fg";

/** 底部的「恢复默认设置」：描边按钮，悬停才透出危险色——它会把密钥和 CLI 列表一起清掉 */
const RESET_BUTTON =
  "rounded-md border border-line-strong px-2.5 py-1 text-[12px] text-fg-muted hover:border-danger-line hover:bg-danger-bg hover:text-danger";

/** 标签在上、控件在下：字体名可能很长，横排放不下。
    action 放在标签那一行的右端，省掉列表下面单独占一行的操作按钮。 */
function Field({
  label,
  hint,
  action,
  children,
}: {
  label: string;
  hint?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 text-[12px] text-fg-muted">{label}</span>
        {action}
      </div>
      <div className="flex items-center gap-2">{children}</div>
      {hint && <p className="text-[11px] text-fg-faint">{hint}</p>}
    </div>
  );
}

/** 设置页里的一组字段：一道细分隔线 + 标题 +（可选）右侧操作，让长页面能扫读 */
function Section({
  title,
  hint,
  action,
  children,
}: {
  title: string;
  hint?: string;
  /** 放标题行右端，例如作用域切换 */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 border-t border-line pt-4 first:border-t-0 first:pt-0">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <h3 className="min-w-0 flex-1 text-[12px] font-semibold text-fg">{title}</h3>
          {action}
        </div>
        {hint && <p className="text-[11px] text-fg-faint">{hint}</p>}
      </div>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}

/** 字号滑杆：右边跟着当前值，拖动即时作用到终端/编辑器上 */
function SizeSlider({
  value,
  onChange,
}: {
  value: number;
  onChange: (next: number) => void;
}) {
  return (
    <>
      <input
        type="range"
        min={FONT_SIZE_MIN}
        max={FONT_SIZE_MAX}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="min-w-0 flex-1 accent-accent"
      />
      <span className="w-9 shrink-0 text-right text-[12px] text-fg-dim tabular-nums">
        {value}px
      </span>
    </>
  );
}

/** 二选一的分段开关（字重、右栏模块的显隐），和主题选择共用一套视觉，省得再给 checkbox 写样式 */
function BoolToggle({
  value,
  options,
  disabledValue,
  onChange,
}: {
  value: boolean;
  options: { value: boolean; label: string }[];
  /** 这一侧点不了，例如右栏只剩最后一个模块时不能再藏 */
  disabledValue?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex shrink-0 gap-0.5 rounded-lg border border-line-strong p-0.5">
      {options.map((option) => {
        const disabled = option.value === disabledValue;
        return (
          <button
            key={option.label}
            type="button"
            onClick={() => onChange(option.value)}
            disabled={disabled}
            className={`rounded-md px-2.5 py-1 text-[12px] ${
              value === option.value
                ? "bg-selected text-fg"
                : "text-fg-dim hover:bg-hover hover:text-fg"
            } ${disabled ? "cursor-not-allowed opacity-40 hover:bg-transparent" : ""}`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** 通用下拉：跟终端主题那个是同一套交互，只是不带色块 */
function Select<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (next: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((item) => item.value === value);

  return (
    <div className="relative w-full">
      <button
        type="button"
        onClick={() => setOpen((isOpen) => !isOpen)}
        className={`${TEXT_INPUT} flex items-center gap-2 text-left hover:border-line-hover`}
      >
        <span className="min-w-0 flex-1 truncate">{current?.label ?? ""}</span>
        <IconChevronDown className="h-3.5 w-3.5 shrink-0 text-fg-faint" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute top-full left-0 z-40 mt-1 flex max-h-64 w-full flex-col overflow-auto rounded border border-line-strong bg-raised py-1 shadow-lg">
            {options.map((item) => (
              <button
                key={item.value}
                type="button"
                onClick={() => {
                  setOpen(false);
                  onChange(item.value);
                }}
                className={`flex items-center gap-2 border-l-2 px-3 py-1.5 text-left text-[12px] ${
                  value === item.value ? "border-accent bg-accent/30 text-accent" : "border-transparent text-fg-muted hover:bg-accent/20 hover:text-fg"
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {value === item.value && (
                  <IconCheck className="h-3.5 w-3.5 shrink-0 text-accent" />
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** 终端程序下拉：候选由后端探测，只列本机真实存在的 shell（第一项是「自动」）。 */
function TerminalShellSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const [options, setOptions] = useState<{ value: string; label: string }[]>([]);

  useEffect(() => {
    let cancelled = false;
    listShells()
      .then((list) => {
        if (!cancelled) {
          setOptions(list.map((item) => ({ value: item.id, label: item.label })));
        }
      })
      .catch(() => {
        // 探测失败时至少留「自动」，别让下拉空着
        if (!cancelled) setOptions([{ value: "", label: "自动" }]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 存了但本机已经没有的 id（换了机器或那个 shell 被卸了）：补一个项，
  // 否则 Select 找不到会显示空白。后端 resolve 时同样回落到自动，标签跟着那个语义走。
  const merged = options.some((item) => item.value === value)
    ? options
    : [...options, { value, label: "自动" }];

  return <Select value={value} options={merged} onChange={onChange} />;
}

/**
 * 终端配色下拉。选项左边带一个双色圆点（左半背景色、右半前景色）——
 * 光给个主题名，选之前完全不知道它长什么样。
 */
function TerminalThemeSelect({
  value,
  fallback,
  preference,
  onChange,
}: {
  /** 空串表示跟随界面主题 */
  value: string;
  /** 跟随界面主题时按哪套内置配色兜底 */
  fallback: ResolvedTheme;
  /** 当前界面配色；「跟随界面主题」项的色块按它取色，跟外面保持一致 */
  preference?: Theme;
  onChange: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = TERMINAL_THEME_OPTIONS.find((option) => option.key === value);

  const swatch = (key: string) => {
    const theme = resolveTerminalTheme(key, fallback, preference);
    return (
      <span
        className="h-3 w-3 shrink-0 rounded-full border border-line-strong"
        style={{
          background: `linear-gradient(135deg, ${theme.background} 50%, ${theme.foreground} 50%)`,
        }}
      />
    );
  };

  const option = (key: string, label: string) => (
    <button
      key={key}
      type="button"
      onClick={() => {
        setOpen(false);
        onChange(key);
      }}
      className={`flex items-center gap-2 border-l-2 px-3 py-1.5 text-left text-[12px] ${
        value === key ? "border-accent bg-accent/30 text-accent" : "border-transparent text-fg-muted hover:bg-accent/20 hover:text-fg"
      }`}
    >
      {swatch(key)}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {value === key && <IconCheck className="h-3.5 w-3.5 shrink-0 text-accent" />}
    </button>
  );

  return (
    <div className="relative w-full">
      <button
        type="button"
        onClick={() => setOpen((isOpen) => !isOpen)}
        className={`${TEXT_INPUT} flex items-center gap-2 text-left hover:border-line-hover`}
      >
        {swatch(value)}
        <span className="min-w-0 flex-1 truncate">
          {current?.label ?? "跟随界面主题"}
        </span>
        <IconChevronDown className="h-3.5 w-3.5 shrink-0 text-fg-faint" />
      </button>

      {open && (
        <>
          {/* 铺一层透明遮罩接住外部点击；它在设置面板内部，点击不会冒到最外层把面板关掉 */}
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute top-full left-0 z-40 mt-1 flex max-h-64 w-full flex-col overflow-auto rounded border border-line-strong bg-raised py-1 shadow-lg">
            {option("", "跟随界面主题")}
            {TERMINAL_THEME_OPTIONS.map((item) => option(item.key, item.label))}
          </div>
        </>
      )}
    </div>
  );
}

/** 主题下拉：悬停或按 ↑↓ 都能实时预览整套配色（界面 + 终端 + 编辑器），
    移开或关闭即还原，点到 / 回车才真正落盘 */
function ThemeSelect() {
  const { preference, setPreference, previewTheme } = useTheme();
  const [open, setOpen] = useState(false);
  /** 键盘高亮的下标；-1 表示还没用键盘选过 */
  const [activeIndex, setActiveIndex] = useState(-1);
  const listRef = useRef<HTMLDivElement | null>(null);
  const current = THEME_OPTIONS.find((item) => item.value === preference);

  // 面板卸载时兜底清掉预览，免得没选就关掉、配色还停在预览那套
  useEffect(() => () => previewTheme(null), [previewTheme]);

  // 键盘把高亮移出可视区时，把那一项滚回来
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    (listRef.current?.children[activeIndex] as HTMLElement | undefined)?.scrollIntoView({
      block: "nearest",
    });
  }, [open, activeIndex]);

  const close = () => {
    setOpen(false);
    setActiveIndex(-1);
    previewTheme(null);
  };

  const openList = () => {
    setOpen(true);
    // 打开即高亮当前项，按 ↑↓ 从它两边接着走
    setActiveIndex(THEME_OPTIONS.findIndex((item) => item.value === preference));
  };

  /** 高亮某一项并预览它；鼠标悬停和键盘上下键都走这里 */
  const highlight = (index: number) => {
    setActiveIndex(index);
    previewTheme(THEME_OPTIONS[index].value);
  };

  const pick = (value: Theme) => {
    setPreference(value);
    close();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!open) {
      // 关着时 ↓ / 回车直接展开，省一次点击
      if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openList();
      }
      return;
    }
    const last = THEME_OPTIONS.length - 1;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        highlight(activeIndex >= last ? 0 : activeIndex + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        highlight(activeIndex <= 0 ? last : activeIndex - 1);
        break;
      case "Home":
        event.preventDefault();
        highlight(0);
        break;
      case "End":
        event.preventDefault();
        highlight(last);
        break;
      case "Enter":
        event.preventDefault();
        if (activeIndex >= 0) pick(THEME_OPTIONS[activeIndex].value);
        break;
      case "Escape":
        event.preventDefault();
        // 设置面板在 window 上也监听 Esc 关整个面板，这里拦一下，只关下拉
        event.stopPropagation();
        close();
        break;
      default:
        break;
    }
  };

  return (
    // 键盘事件挂在外层：打开时焦点在触发按钮上，事件冒泡到这里统一处理
    <div className="relative w-full" onKeyDown={onKeyDown}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? close() : openList())}
        className={`${TEXT_INPUT} flex items-center gap-2 text-left hover:border-line-hover`}
      >
        {current && <ThemeSwatch swatch={current.swatch} />}
        <span className="min-w-0 flex-1 truncate">{current?.label ?? ""}</span>
        <IconChevronDown className="h-3.5 w-3.5 shrink-0 text-fg-faint" />
      </button>

      {open && (
        <>
          {/* 铺一层透明遮罩接住外部点击；它在设置面板内部，点击不会冒到最外层把面板关掉 */}
          <div className="fixed inset-0 z-30" onClick={close} />
          <div
            ref={listRef}
            role="listbox"
            onMouseLeave={() => previewTheme(null)}
            className="absolute top-full left-0 z-40 mt-1 flex max-h-72 w-full flex-col overflow-auto rounded border border-line-strong bg-raised py-1 shadow-lg"
          >
            {THEME_OPTIONS.map((item, index) => (
              <button
                key={item.value}
                type="button"
                role="option"
                aria-selected={preference === item.value}
                onMouseEnter={() => highlight(index)}
                onClick={() => pick(item.value)}
                className={`flex items-center gap-2 border-l-2 px-3 py-1.5 text-left text-[12px] ${
                  preference === item.value
                    ? "border-accent bg-accent/30 text-accent"
                    : activeIndex === index
                      ? "border-transparent bg-accent/20 text-fg"
                      : "border-transparent text-fg-muted hover:bg-accent/20 hover:text-fg"
                }`}
              >
                <ThemeSwatch swatch={item.swatch} />
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {preference === item.value && (
                  <IconCheck className="h-3.5 w-3.5 shrink-0 text-accent" />
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** 主题下拉里的小圆点：一半背景一半前景，一眼看出明暗与主色 */
function ThemeSwatch({ swatch }: { swatch: [string, string] }) {
  return (
    <span
      className="h-3 w-3 shrink-0 rounded-full border border-line-strong"
      style={{ background: `linear-gradient(135deg, ${swatch[0]} 50%, ${swatch[1]} 50%)` }}
    />
  );
}

/** 弹窗拖出来的位置和大小，单位 px，相对遮罩左上角 */
interface DialogBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 正在拖哪几条边；角上同时命中横竖两条 */
interface ResizeEdges {
  n?: boolean;
  s?: boolean;
  e?: boolean;
  w?: boolean;
}

/** 一次缩放拖动的起点状态；null 表示没在拖 */
interface ResizeDrag {
  edges: ResizeEdges;
  startX: number;
  startY: number;
  start: DialogBox;
  /** 遮罩内容区的范围（相对遮罩左上角）。弹窗不能拖出这里，否则会跑出屏幕 */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

/** 一次挪位置的拖动；只记起点，尺寸始终不变 */
interface MoveDrag {
  startX: number;
  startY: number;
  start: DialogBox;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

/** 能缩到多小，再小导航栏和内容就挤没了 */
const DIALOG_MIN_WIDTH = 380;
const DIALOG_MIN_HEIGHT = 320;

function clamp(min: number, value: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

/**
 * 八个缩放热区，压在弹窗的四条边和四个角上。
 *
 * 边只占 4px 窄带、并且从角上让开 12px：内容区的滚动条紧贴着卡片右缘，
 * 热区铺太宽会把滚动条整个盖住，滚不动也拖不了。
 */
const RESIZE_HANDLES: { edges: ResizeEdges; className: string }[] = [
  { edges: { n: true }, className: "inset-x-3 top-0 h-1 cursor-ns-resize" },
  { edges: { s: true }, className: "inset-x-3 bottom-0 h-1 cursor-ns-resize" },
  { edges: { w: true }, className: "inset-y-3 left-0 w-1 cursor-ew-resize" },
  { edges: { e: true }, className: "inset-y-3 right-0 w-1 cursor-ew-resize" },
  { edges: { n: true, w: true }, className: "top-0 left-0 h-3 w-3 cursor-nwse-resize" },
  { edges: { n: true, e: true }, className: "top-0 right-0 h-3 w-3 cursor-nesw-resize" },
  { edges: { s: true, w: true }, className: "bottom-0 left-0 h-3 w-3 cursor-nesw-resize" },
  { edges: { s: true, e: true }, className: "bottom-0 right-0 h-3 w-3 cursor-nwse-resize" },
];

const AGENT_MODE_OPTIONS: { value: AgentProfile["mode"]; label: string }[] = [
  { value: "primary", label: "主智能体" },
  { value: "subagent", label: "子智能体" },
  { value: "all", label: "两者皆可" },
];

/** 一条技能 / 一个 agent 的启用开关。用自绘滑块，省得给 checkbox 单独写样式 */
function Toggle({
  checked,
  onChange,
  title,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  title: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      title={title}
      onClick={() => onChange(!checked)}
      className={`flex h-5 w-9 shrink-0 items-center rounded-full px-0.5 transition-colors ${
        checked ? "bg-accent" : "bg-active"
      }`}
    >
      <span
        className={`h-4 w-4 rounded-full bg-app transition-transform ${
          checked ? "translate-x-4" : ""
        }`}
      />
    </button>
  );
}

/** 折叠条：左侧一个会转的箭头 + 标题，和条目行共用一套折叠交互 */
function CollapseHeader({
  open,
  onToggle,
  placeholder,
  label,
  mono,
}: {
  open: boolean;
  onToggle: () => void;
  /** 值为空时显示的灰字 */
  placeholder: string;
  label: string;
  mono?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
    >
      <IconChevronDown
        className={`h-3.5 w-3.5 shrink-0 text-fg-faint transition-transform ${
          open ? "" : "-rotate-90"
        }`}
      />
      <span
        className={`min-w-0 flex-1 truncate text-[12px] ${mono ? "font-mono" : ""} ${
          label ? "text-fg" : "text-fg-faint"
        }`}
      >
        {label || placeholder}
      </span>
    </button>
  );
}

/** 一个模型的编辑行：id 是接口认的名字，显示名留空就用 id */
function ModelRow({
  model,
  onChange,
  onRemove,
}: {
  model: ProviderModel;
  onChange: (next: ProviderModel) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <input
        type="text"
        value={model.id}
        spellCheck={false}
        placeholder="模型 ID，如 deepseek-chat"
        onChange={(event) => onChange({ ...model, id: event.target.value })}
        className={`${TEXT_INPUT} min-w-0 flex-1 font-mono`}
      />
      <input
        type="text"
        value={model.name}
        spellCheck={false}
        placeholder="显示名（可选）"
        onChange={(event) => onChange({ ...model, name: event.target.value })}
        className={`${TEXT_INPUT} min-w-0 flex-1`}
      />
      <Toggle
        checked={model.enabled}
        title={model.enabled ? "已启用" : "已停用"}
        onChange={(next) => onChange({ ...model, enabled: next })}
      />
      <button type="button" onClick={onRemove} title="删除模型" className={LIST_ACTION}>
        <IconClose className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/**
 * 「从接口拉取」之后的选择面板：把拉回来的模型列出来勾选。
 *
 * 为什么不直接全量并进列表：OpenRouter、SiliconFlow 这类动辄几百个模型，
 * 一次塞进去会把设置里这一节和 opencode.json 都撑爆。所以先看、再挑。
 * 已经添加过的条目也在列表里（标成「已添加」且不可勾选），免得用户以为是漏了。
 */
function ModelPicker({
  models,
  existing,
  picked,
  filter,
  onFilter,
  onToggle,
  onSelectAll,
  onCancel,
  onConfirm,
}: {
  models: RemoteModel[];
  /** 已经在提供商里的模型 id */
  existing: Set<string>;
  picked: Set<string>;
  filter: string;
  onFilter: (next: string) => void;
  onToggle: (id: string) => void;
  /** 全选 / 全不选，只作用在传进来的这批（即当前筛选结果） */
  onSelectAll: (ids: string[]) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const keyword = filter.trim().toLowerCase();
  const shown = keyword
    ? models.filter(
        (model) =>
          model.id.toLowerCase().includes(keyword) || model.name.toLowerCase().includes(keyword),
      )
    : models;
  const selectable = shown.filter((model) => !existing.has(model.id)).map((model) => model.id);

  return (
    <div className="flex w-full flex-col gap-2 rounded-md border border-line-strong bg-surface p-2">
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={filter}
          spellCheck={false}
          placeholder={`筛选（共 ${models.length} 个）`}
          onChange={(event) => onFilter(event.target.value)}
          className={`${TEXT_INPUT} min-w-0 flex-1`}
        />
        <button
          type="button"
          onClick={() => onSelectAll(selectable)}
          disabled={selectable.length === 0}
          className={`shrink-0 rounded-md border border-line-strong px-2 py-1 text-[11px] text-fg-muted hover:bg-hover hover:text-fg ${
            selectable.length === 0 ? "cursor-not-allowed opacity-40 hover:bg-transparent" : ""
          }`}
        >
          {selectable.length > 0 && selectable.every((id) => picked.has(id))
            ? "全不选"
            : "全选"}
        </button>
      </div>

      <div className="flex max-h-56 min-h-0 flex-col overflow-y-auto rounded border border-line">
        {shown.length === 0 ? (
          <p className="px-2 py-3 text-center text-[11px] text-fg-faint">没有匹配的模型</p>
        ) : (
          shown.map((model) => {
            const added = existing.has(model.id);
            const on = picked.has(model.id);
            return (
              <button
                key={model.id}
                type="button"
                disabled={added}
                onClick={() => onToggle(model.id)}
                className={`flex items-center gap-2 px-2 py-1 text-left ${
                  added ? "cursor-not-allowed opacity-50" : "hover:bg-hover"
                }`}
              >
                <span
                  className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border ${
                    on ? "border-accent bg-accent text-app" : "border-line-strong"
                  }`}
                >
                  {on && <IconCheck className="h-2.5 w-2.5" />}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg">
                  {model.id}
                </span>
                {model.name && (
                  <span className="min-w-0 flex-1 truncate text-[11px] text-fg-dim">
                    {model.name}
                  </span>
                )}
                {added && <span className="shrink-0 text-[11px] text-fg-faint">已添加</span>}
              </button>
            );
          })
        )}
      </div>

      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 text-[11px] text-fg-faint">
          已选 {picked.size} 个
        </span>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-line-strong px-2.5 py-1 text-[12px] text-fg-muted hover:bg-hover hover:text-fg"
        >
          取消
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="rounded-md border border-line-strong px-2.5 py-1 text-[12px] text-fg-muted hover:bg-hover hover:text-fg"
        >
          添加选中的
        </button>
      </div>
    </div>
  );
}

/** 一个提供商：折叠时只占一行（名字 + 模型数 + 开关），展开才编辑全部字段 */
function ProviderEditor({
  provider,
  open,
  isDefault,
  secretStoreError,
  onToggle,
  onChange,
  onSetDefault,
  onDuplicate,
  onRemove,
}: {
  provider: AiProvider;
  open: boolean;
  isDefault: boolean;
  /** 系统钥匙串不可用时的原因；非空时密钥存不上，得如实说 */
  secretStoreError: string;
  onToggle: () => void;
  onChange: (next: AiProvider) => void;
  onSetDefault: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
}) {
  const patch = (part: Partial<AiProvider>) => onChange({ ...provider, ...part });

  /** 刚敲进去、还没落钥匙串的密钥。存进去就清空——明文不在设置面板里过夜 */
  const [draftKey, setDraftKey] = useState("");
  /** 密钥默认打码，点一下才明文——设置面板经常有人在旁边看着 */
  const [revealKey, setRevealKey] = useState(false);
  /** 保存 / 清除 / 连接测试 / 拉列表的结果，显示在按钮下面 */
  const [probe, setProbe] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  /** 拉回来的模型列表；非空时展开选择面板 */
  const [remote, setRemote] = useState<RemoteModel[] | null>(null);
  /** 选择面板里勾中的模型 id */
  const [picked, setPicked] = useState<Set<string>>(new Set());
  /** 选择面板的筛选词。OpenRouter 这类动辄几百个模型，不筛选没法看 */
  const [filter, setFilter] = useState("");

  const enabledModelCount = provider.models.filter(
    (model) => model.enabled && model.id.trim() !== "",
  ).length;
  const missing = provider.baseUrl.trim() === "" || enabledModelCount === 0;

  const saveKey = async () => {
    if (draftKey.trim() === "") return;
    setBusy(true);
    setProbe(null);
    try {
      await setSecret(provider.id, draftKey);
      setDraftKey("");
      patch({ apiKeySet: true });
      setProbe({ ok: true, text: "密钥已保存到系统钥匙串" });
    } catch (reason) {
      setProbe({ ok: false, text: String(reason) });
    } finally {
      setBusy(false);
    }
  };

  const clearKey = async () => {
    setBusy(true);
    setProbe(null);
    try {
      await deleteSecret(provider.id);
      patch({ apiKeySet: false });
      setProbe({ ok: true, text: "已从系统钥匙串删除" });
    } catch (reason) {
      setProbe({ ok: false, text: String(reason) });
    } finally {
      setBusy(false);
    }
  };

  /** 已经在下发列表里的模型 id：选择面板里标成「已添加」并禁掉，避免重复 */
  const existingIds = new Set(
    provider.models.map((model) => model.id.trim()).filter((id) => id !== ""),
  );

  const fetchModels = async () => {
    setBusy(true);
    setProbe(null);
    try {
      const models = await listProviderModels(
        { baseUrl: provider.baseUrl, providerId: provider.id, model: "" },
        draftKey.trim() || undefined,
      );
      setRemote(models);
      setPicked(new Set());
      setFilter("");
    } catch (reason) {
      setRemote(null);
      setProbe({ ok: false, text: String(reason) });
    } finally {
      setBusy(false);
    }
  };

  /** 把勾中的模型并进列表：已有的不动（保住手填的显示名和启停状态），只追加新的 */
  const confirmPick = () => {
    if (!remote) return;
    const additions = remote
      .filter((model) => picked.has(model.id) && !existingIds.has(model.id))
      .map((model) => ({ id: model.id, name: model.name, enabled: true }));
    if (additions.length > 0) patch({ models: [...provider.models, ...additions] });
    setRemote(null);
    setPicked(new Set());
  };

  const test = async () => {
    setBusy(true);
    setProbe(null);
    try {
      // 探针优先拿第一个启用模型去试：接口不支持 GET /models 时后端靠它退化
      const first = provider.models.find((model) => model.enabled && model.id.trim() !== "");
      const text = await testProviderConnection(
        {
          baseUrl: provider.baseUrl,
          providerId: provider.id,
          model: first?.id.trim() ?? "",
        },
        // 刚敲的还没保存，直接让后端拿这份去测，不必先存一遍
        draftKey.trim() || undefined,
      );
      setProbe({ ok: true, text });
    } catch (reason) {
      setProbe({ ok: false, text: String(reason) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-full overflow-hidden rounded-md border border-line-strong">
      <div className="flex items-center gap-1.5 p-2">
        <CollapseHeader
          open={open}
          onToggle={onToggle}
          placeholder="未命名提供商"
          label={provider.name}
        />
        {isDefault && (
          <span className="shrink-0 rounded bg-selected px-1.5 py-0.5 text-[11px] text-fg-dim">
            默认
          </span>
        )}
        {!provider.enabled && (
          <span className="shrink-0 text-[11px] text-fg-faint">已停用</span>
        )}
        <span className="shrink-0 text-[11px] text-fg-faint">
          {enabledModelCount} 个模型
        </span>
        <Toggle
          checked={provider.enabled}
          title={provider.enabled ? "已启用" : "已停用"}
          onChange={(next) => patch({ enabled: next })}
        />
        <button type="button" onClick={onDuplicate} title="复制提供商" className={HEAD_ACTION}>
          <IconCopy className="h-3.5 w-3.5" />
        </button>
        <button type="button" onClick={onRemove} title="删除提供商" className={LIST_ACTION}>
          <IconClose className="h-3.5 w-3.5" />
        </button>
      </div>

      {open && (
        <div className="flex flex-col gap-3 border-t border-line p-2">
          <Field label="名称" hint="只用于界面展示，改名不会动 ID">
            <input
              type="text"
              value={provider.name}
              spellCheck={false}
              placeholder="如 DeepSeek"
              onChange={(event) => patch({ name: event.target.value })}
              className={TEXT_INPUT}
            />
          </Field>
          <Field
            label="接口地址"
            hint="OpenAI 兼容基地址，如 https://api.deepseek.com/v1、http://localhost:11434/v1（Ollama）"
          >
            <input
              type="text"
              value={provider.baseUrl}
              spellCheck={false}
              placeholder="https://api.openai.com/v1"
              onChange={(event) => patch({ baseUrl: event.target.value })}
              className={TEXT_INPUT}
            />
          </Field>
          <Field
            label="API 密钥"
            hint="存进操作系统的凭据库（Windows 凭据管理器 / macOS 钥匙串 / Linux Secret Service），
              明文不写进设置、也不写进 opencode 配置文件；本地模型可以留空"
          >
            <input
              type={revealKey ? "text" : "password"}
              value={draftKey}
              spellCheck={false}
              placeholder={provider.apiKeySet ? "已保存，填新的可覆盖" : "sk-…"}
              onChange={(event) => setDraftKey(event.target.value)}
              className={TEXT_INPUT}
            />
            <button
              type="button"
              onClick={() => setRevealKey((current) => !current)}
              className="shrink-0 rounded-md border border-line-strong px-2 py-1 text-[11px] text-fg-muted hover:bg-hover hover:text-fg"
            >
              {revealKey ? "隐藏" : "显示"}
            </button>
            <button
              type="button"
              onClick={() => void saveKey()}
              disabled={busy || draftKey.trim() === "" || secretStoreError !== ""}
              title={secretStoreError !== "" ? secretStoreError : "写进系统钥匙串"}
              className={`shrink-0 rounded-md border border-line-strong px-2 py-1 text-[11px] text-fg-muted hover:bg-hover hover:text-fg ${
                busy || draftKey.trim() === "" || secretStoreError !== ""
                  ? "cursor-not-allowed opacity-40 hover:bg-transparent"
                  : ""
              }`}
            >
              保存
            </button>
            {provider.apiKeySet && (
              <button
                type="button"
                onClick={() => void clearKey()}
                disabled={busy}
                title="从系统钥匙串删掉这个提供商的密钥"
                className={`shrink-0 rounded-md border border-line-strong px-2 py-1 text-[11px] text-fg-muted hover:border-danger-line hover:bg-danger-bg hover:text-danger ${
                  busy ? "cursor-not-allowed opacity-40 hover:bg-transparent" : ""
                }`}
              >
                清除
              </button>
            )}
          </Field>

          <p
            className={`text-[11px] leading-relaxed ${
              secretStoreError !== "" ? "text-danger" : "text-fg-faint"
            }`}
          >
            {secretStoreError !== ""
              ? secretStoreError
              : provider.apiKeySet
                ? "密钥已保存在系统钥匙串，这里不会再回显。"
                : "还没有保存密钥。点「保存」后写进系统钥匙串，之后不回显。"}
          </p>

          <Field
            label="模型"
            hint="可以手动填 ID，也可以「从接口拉取」勾选；停用或没填 ID 的不会下发"
            action={
              <>
                <button
                  type="button"
                  title="从接口拉取可用模型"
                  onClick={() => void fetchModels()}
                  disabled={provider.baseUrl.trim() === "" || busy}
                  className={`${HEAD_ACTION} ${
                    provider.baseUrl.trim() === "" || busy
                      ? "cursor-not-allowed opacity-40 hover:bg-transparent"
                      : ""
                  }`}
                >
                  <IconDownload className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  title="手动新增模型"
                  onClick={() => patch({ models: [...provider.models, emptyModel()] })}
                  className={HEAD_ACTION}
                >
                  <IconPlus className="h-3.5 w-3.5" />
                </button>
              </>
            }
          >
            <div className="flex w-full flex-col gap-2">
              {provider.models.length === 0 ? (
                <p className="text-[11px] text-fg-faint">还没有模型</p>
              ) : (
                provider.models.map((model, index) => (
                  <ModelRow
                    key={index}
                    model={model}
                    onChange={(next) =>
                      patch({
                        models: provider.models.map((item, i) => (i === index ? next : item)),
                      })
                    }
                    onRemove={() =>
                      patch({ models: provider.models.filter((_, i) => i !== index) })
                    }
                  />
                ))
              )}
            </div>
          </Field>

          {remote && (
            <ModelPicker
              models={remote}
              existing={existingIds}
              picked={picked}
              filter={filter}
              onFilter={setFilter}
              onToggle={(id) =>
                setPicked((current) => {
                  const next = new Set(current);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })
              }
              onSelectAll={(ids) =>
                setPicked((current) => {
                  // 只影响传进来的这批（即当前筛选结果）；全不选也该只作用在它们身上
                  const next = new Set(current);
                  const allPicked = ids.every((id) => next.has(id));
                  for (const id of ids) {
                    if (allPicked) next.delete(id);
                    else next.add(id);
                  }
                  return next;
                })
              }
              onCancel={() => {
                setRemote(null);
                setPicked(new Set());
              }}
              onConfirm={confirmPick}
            />
          )}

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void test()}
              disabled={provider.baseUrl.trim() === "" || busy}
              className={`rounded-md border border-line-strong px-2.5 py-1 text-[12px] text-fg-muted hover:bg-hover hover:text-fg ${
                provider.baseUrl.trim() === "" || busy
                  ? "cursor-not-allowed opacity-40 hover:bg-transparent"
                  : ""
              }`}
            >
              {busy ? "测试中…" : "测试连接"}
            </button>
            {!isDefault && (
              <button
                type="button"
                onClick={onSetDefault}
                disabled={missing}
                title={missing ? "先填接口地址、并至少启用一个模型" : "设为全局默认"}
                className={`rounded-md border border-line-strong px-2.5 py-1 text-[12px] text-fg-muted hover:bg-hover hover:text-fg ${
                  missing ? "cursor-not-allowed opacity-40 hover:bg-transparent" : ""
                }`}
              >
                设为默认
              </button>
            )}
          </div>

          {probe && (
            <p
              className={`text-[11px] leading-relaxed ${
                probe.ok ? "text-fg-muted" : "text-danger"
              }`}
            >
              {probe.text}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** 一条技能：折叠时只占一行（名字 + 开关），展开才编辑描述和正文 */
function SkillEditor({
  skill,
  open,
  onToggle,
  onChange,
  onRemove,
}: {
  skill: AgentSkill;
  open: boolean;
  onToggle: () => void;
  onChange: (next: AgentSkill) => void;
  onRemove: () => void;
}) {
  const patch = (part: Partial<AgentSkill>) => onChange({ ...skill, ...part });
  const invalid = skill.name.trim() !== "" && !isValidAgentName(skill.name);
  return (
    <div className="w-full overflow-hidden rounded-md border border-line-strong">
      <div className="flex items-center gap-1.5 p-2">
        <CollapseHeader
          open={open}
          onToggle={onToggle}
          mono
          placeholder="未命名技能"
          label={skill.name}
        />
        {invalid && <span className="shrink-0 text-[11px] text-danger">名称非法</span>}
        {!skill.enabled && <span className="shrink-0 text-[11px] text-fg-faint">已停用</span>}
        <Toggle
          checked={skill.enabled}
          title={skill.enabled ? "已启用" : "已停用"}
          onChange={(next) => patch({ enabled: next })}
        />
        <button type="button" onClick={onRemove} title="删除技能" className={LIST_ACTION}>
          <IconClose className="h-3.5 w-3.5" />
        </button>
      </div>
      {open && (
        <div className="flex flex-col gap-2 border-t border-line p-2">
          <input
            type="text"
            value={skill.name}
            spellCheck={false}
            placeholder="技能名（小写字母、数字、连字符）"
            onChange={(event) => patch({ name: event.target.value })}
            className={`${TEXT_INPUT} font-mono`}
          />
          {invalid && (
            <p className="text-[11px] text-danger">
              名字只能用小写字母、数字和单个连字符，例如 my-skill
            </p>
          )}
          <input
            type="text"
            value={skill.description}
            placeholder="描述：什么时候该用它（必填）"
            onChange={(event) => patch({ description: event.target.value })}
            className={TEXT_INPUT}
          />
          <textarea
            value={skill.content}
            rows={4}
            spellCheck={false}
            placeholder="技能正文（markdown）"
            onChange={(event) => patch({ content: event.target.value })}
            className={`${TEXT_INPUT} resize-y font-mono leading-relaxed`}
          />
        </div>
      )}
    </div>
  );
}

/**
 * 默认模型存的那对指向可能刚被删掉、停用或清空。失效就把它写回落后的结果，
 * 让「存着的」和「界面上显示的」是同一个——不然重开设置面板又会跳到别家。
 */
function defaultPatch(settings: Settings): Partial<Settings> {
  const resolved = resolveDefaultModel(settings);
  if (!resolved) {
    return settings.aiDefaultProvider || settings.aiDefaultModel
      ? { aiDefaultProvider: "", aiDefaultModel: "" }
      : {};
  }
  if (
    resolved.providerId === settings.aiDefaultProvider &&
    resolved.modelId === settings.aiDefaultModel
  ) {
    return {};
  }
  return { aiDefaultProvider: resolved.providerId, aiDefaultModel: resolved.modelId };
}

/** 有多少个 Agent 绑在这个提供商的模型上（全局层 + 所有项目层） */
function countAgentRefs(settings: Settings, providerId: string): number {
  const prefix = modelRef(providerId, "");
  const layers = [settings.agentGlobal, ...Object.values(settings.agentProjects)];
  return layers.reduce(
    (total, layer) =>
      total +
      layer.agents.filter((agent) => agent.model.trim().startsWith(prefix)).length,
    0,
  );
}

/** 模式在折叠行上的短标签 */
const MODE_SHORT: Record<AgentProfile["mode"], string> = {
  primary: "主",
  subagent: "子",
  all: "通用",
};

/** 一个自定义 agent：折叠时只占一行（名字 + 模式），展开才编辑其余字段 */
function AgentEditor({
  agent,
  open,
  modelOptions,
  onToggle,
  onChange,
  onRemove,
}: {
  agent: AgentProfile;
  open: boolean;
  /** 可绑定的 `provider/model` 候选，来自「模型提供商」那一节 */
  modelOptions: { value: string; label: string }[];
  onToggle: () => void;
  onChange: (next: AgentProfile) => void;
  onRemove: () => void;
}) {
  const patch = (part: Partial<AgentProfile>) => onChange({ ...agent, ...part });
  const invalid = agent.name.trim() !== "" && !isValidAgentName(agent.name);

  // 绑定值可能指向已被删掉的提供商/模型：补一条「不可用」的候选，
  // 不然下拉会显示成空的，让人以为根本没绑
  const bound = agent.model.trim();
  const options = [
    { value: "", label: "使用全局默认" },
    ...modelOptions,
    ...(bound && !modelOptions.some((option) => option.value === bound)
      ? [{ value: bound, label: `${bound}（不可用）` }]
      : []),
  ];
  return (
    <div className="w-full overflow-hidden rounded-md border border-line-strong">
      <div className="flex items-center gap-1.5 p-2">
        <CollapseHeader
          open={open}
          onToggle={onToggle}
          mono
          placeholder="未命名 Agent"
          label={agent.name}
        />
        {invalid && <span className="shrink-0 text-[11px] text-danger">名称非法</span>}
        {!agent.enabled && <span className="shrink-0 text-[11px] text-fg-faint">已停用</span>}
        <span className="shrink-0 rounded bg-active px-1.5 py-0.5 text-[11px] text-fg-dim">
          {MODE_SHORT[agent.mode]}
        </span>
        <Toggle
          checked={agent.enabled}
          title={agent.enabled ? "已启用" : "已停用"}
          onChange={(next) => patch({ enabled: next })}
        />
        <button type="button" onClick={onRemove} title="删除 Agent" className={LIST_ACTION}>
          <IconClose className="h-3.5 w-3.5" />
        </button>
      </div>
      {open && (
        <div className="flex flex-col gap-2 border-t border-line p-2">
          <input
            type="text"
            value={agent.name}
            spellCheck={false}
            placeholder="名称（小写字母、数字、连字符）"
            onChange={(event) => patch({ name: event.target.value })}
            className={`${TEXT_INPUT} font-mono`}
          />
          {invalid && (
            <p className="text-[11px] text-danger">
              名称只能用小写字母、数字和单个连字符，例如 code-reviewer
            </p>
          )}
          <input
            type="text"
            value={agent.description}
            placeholder="描述：它做什么（必填）"
            onChange={(event) => patch({ description: event.target.value })}
            className={TEXT_INPUT}
          />
          <div className="flex items-center gap-2">
            <div className="w-36 shrink-0">
              <Select
                value={agent.mode}
                options={AGENT_MODE_OPTIONS}
                onChange={(next) => patch({ mode: next })}
              />
            </div>
            <div className="min-w-0 flex-1">
              <Select
                value={bound}
                options={options}
                onChange={(next) => patch({ model: next })}
              />
            </div>
          </div>
          <textarea
            value={agent.prompt}
            rows={4}
            spellCheck={false}
            placeholder="系统提示词：告诉它该怎么做"
            onChange={(event) => patch({ prompt: event.target.value })}
            className={`${TEXT_INPUT} resize-y font-mono leading-relaxed`}
          />
        </div>
      )}
    </div>
  );
}

/** 一层智能体配置的编辑区：规则 / 记忆 / 技能 / Agents。全局层与项目层共用 */
function LayerEditor({
  layer,
  modelOptions,
  onChange,
}: {
  layer: AgentLayer;
  /** 透传给 AgentEditor 的模型候选；来源是「模型提供商」那一节 */
  modelOptions: { value: string; label: string }[];
  onChange: (next: AgentLayer) => void;
}) {
  const patch = (part: Partial<AgentLayer>) => onChange({ ...layer, ...part });

  // 手风琴：一次只展开一条技能 / 一个 agent，否则列表一长整页都被撑开。
  // 新加的条目直接展开，让用户能马上填名字
  const [openSkill, setOpenSkill] = useState<number | null>(null);
  const [openAgent, setOpenAgent] = useState<number | null>(null);

  const addSkill = () => {
    setOpenSkill(layer.skills.length);
    patch({
      skills: [
        ...layer.skills,
        { name: "", description: "", content: "", enabled: true },
      ],
    });
  };
  const addAgent = () => {
    setOpenAgent(layer.agents.length);
    patch({
      agents: [
        ...layer.agents,
        { name: "", description: "", mode: "subagent", model: "", prompt: "", enabled: true },
      ],
    });
  };

  return (
    <>
      <Field
        label="规则"
        hint="每次对话都会注入，用来约束智能体的行为（相当于 opencode 的 AGENTS.md）"
      >
        <textarea
          value={layer.rules}
          rows={4}
          spellCheck={false}
          placeholder="例如：改动前先读 README；注释一律用中文；不要顺手重构无关代码…"
          onChange={(event) => patch({ rules: event.target.value })}
          className={`${TEXT_INPUT} resize-y font-mono leading-relaxed`}
        />
      </Field>

      <Field
        label="记忆"
        hint="长期沉淀的事实与偏好，同样每次对话注入；和「规则」分开只是为了好管理"
      >
        <textarea
          value={layer.memory}
          rows={4}
          spellCheck={false}
          placeholder="例如：本机 cargo 走 tuna 镜像；应用打包主体是「硅原子」…"
          onChange={(event) => patch({ memory: event.target.value })}
          className={`${TEXT_INPUT} resize-y font-mono leading-relaxed`}
        />
      </Field>

      <Field
        label="技能"
        hint="每条物化成一份 SKILL.md，智能体按需加载；停用或名字非法的条目不会下发"
        action={
          <button type="button" onClick={addSkill} title="新增技能" className={HEAD_ACTION}>
            <IconPlus className="h-3.5 w-3.5" />
          </button>
        }
      >
        <div className="flex w-full flex-col gap-2">
          {layer.skills.length === 0 ? (
            <p className="text-[11px] text-fg-faint">还没有技能</p>
          ) : (
            layer.skills.map((skill, index) => (
              <SkillEditor
                key={index}
                skill={skill}
                open={openSkill === index}
                onToggle={() => setOpenSkill(openSkill === index ? null : index)}
                onChange={(next) =>
                  patch({
                    skills: layer.skills.map((item, i) => (i === index ? next : item)),
                  })
                }
                onRemove={() => {
                  setOpenSkill(null);
                  patch({ skills: layer.skills.filter((_, i) => i !== index) });
                }}
              />
            ))
          )}
        </div>
      </Field>

      <Field
        label="Agents"
        hint="自定义智能体；主智能体能在这里的对话面板顶部切换，子智能体由主智能体按需调用"
        action={
          <button type="button" onClick={addAgent} title="新增 Agent" className={HEAD_ACTION}>
            <IconPlus className="h-3.5 w-3.5" />
          </button>
        }
      >
        <div className="flex w-full flex-col gap-2">
          {layer.agents.length === 0 ? (
            <p className="text-[11px] text-fg-faint">还没有自定义 Agent</p>
          ) : (
            layer.agents.map((agent, index) => (
              <AgentEditor
                key={index}
                agent={agent}
                modelOptions={modelOptions}
                open={openAgent === index}
                onToggle={() => setOpenAgent(openAgent === index ? null : index)}
                onChange={(next) =>
                  patch({
                    agents: layer.agents.map((item, i) => (i === index ? next : item)),
                  })
                }
                onRemove={() => {
                  setOpenAgent(null);
                  patch({ agents: layer.agents.filter((_, i) => i !== index) });
                }}
              />
            ))
          )}
        </div>
      </Field>
    </>
  );
}

function DependencyRow({
  id,
  label,
  detail,
  installing,
  checking,
  status,
  onInstall,
}: {
  id: string;
  label: string;
  detail: string;
  installing: boolean;
  checking: boolean;
  status?: DependencyStatus;
  onInstall: (id: string) => void;
}) {
  const installed = status?.installed === true;
  return (
    <div
      className={`group flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors ${
        "border-line bg-surface hover:border-line-hover"
      }`}
    >
      <div
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
          installed ? "bg-ok/10 text-ok" : "bg-raised text-fg-faint"
        }`}
      >
        {installed ? (
          <span className="flex h-5 w-5 items-center justify-center rounded-full border border-ok/50">
            <IconCheck className="h-3.5 w-3.5" />
          </span>
        ) : (
          <IconDownload className={`h-4 w-4 ${installing ? "animate-spin" : ""}`} />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="text-[12px] font-medium text-fg">{label}</p>
          {installed && (
            <span className="rounded-full bg-ok/10 px-1.5 py-0.5 text-[10px] font-medium text-ok">
              已安装
            </span>
          )}
        </div>
        <p className="mt-0.5 truncate text-[11px] text-fg-faint">{detail}</p>
        {installed && status.version && (
          <p className="mt-0.5 truncate font-mono text-[10px] text-ok/80">{status.version}</p>
        )}
      </div>
      {installed ? (
        <span className="shrink-0 text-[11px] text-ok">就绪</span>
      ) : (
        <button
          type="button"
          disabled={checking || installing}
          onClick={() => onInstall(id)}
          className="flex shrink-0 items-center gap-1.5 rounded-md border border-line-strong px-2.5 py-1.5 text-[12px] text-fg-muted transition-colors hover:border-accent-line hover:bg-hover hover:text-fg disabled:cursor-wait disabled:opacity-50"
        >
          {checking ? "检查中…" : installing ? "安装中…" : "安装"}
        </button>
      )}
    </div>
  );
}

export function SettingsDialog({ onClose, cwd = null }: SettingsDialogProps) {
  const { settings, update, reset, secretNotice } = useSettings();
  // 开发调试版可能被 src-tauri/.env 覆盖，下面在 AI 分组里如实标出来（正式版恒为空）
  const devAi = useDevAiOverrides();
  const overriddenAi = [
    devAi.baseUrl ? "接口地址" : "",
    devAi.model ? "模型" : "",
    devAi.apiKeySet ? "API 密钥" : "",
  ].filter((label) => label !== "");
  const { theme, palette, setPreference } = useTheme();
  const [tab, setTab] = useState<TabId>("appearance");
  /** 「智能体」分类的作用域：全局层还是当前项目的层 */
  const [agentScope, setAgentScope] = useState<"global" | "project">("global");
  /** 等确认的「恢复默认」；非空时弹确认框 */
  const [confirmReset, setConfirmReset] = useState(false);
  /** 提供商列表的手风琴：一次只展开一条，和技能 / Agent 一个交互 */
  const [openProvider, setOpenProvider] = useState<number | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [installMessage, setInstallMessage] = useState("");
  const [dependencyStatuses, setDependencyStatuses] = useState<Record<string, DependencyStatus>>({});
  const [checkingDependencies, setCheckingDependencies] = useState(true);
  /** 等确认的「删除提供商」；带上被引用的次数，确认框里说清影响面 */
  const [pendingRemove, setPendingRemove] = useState<{
    provider: AiProvider;
    refs: number;
  } | null>(null);
  // 一次滚轮手势会连着抛好几个事件，不挡一下会一口气翻过两三个分类
  const lastFlipRef = useRef(0);
  /** null = 还没拖过，按类名给的默认尺寸居中摆；拖过之后是具体像素 */
  const [box, setBox] = useState<DialogBox | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<ResizeDrag | null>(null);
  const moveRef = useRef<MoveDrag | null>(null);

  // 右边栏只剩一个模块开着时，它的「隐藏」不能再点，否则右边栏就空了。
  // 顺序照 ToolRail 的注册表来，加模块时这里跟着补一行
  const rightVisible: Record<ToolId, boolean> = {
    files: settings.rightFilesVisible,
    changes: settings.rightChangesVisible,
    search: settings.rightSearchVisible,
    browser: settings.rightBrowserVisible,
  };
  const shownRightTools = RIGHT_TOOLS.filter((tool) => rightVisible[tool.id]);
  const lastVisible = shownRightTools.length === 1 ? shownRightTools[0].id : null;

  const refreshDependencies = async () => {
    setCheckingDependencies(true);
    try {
      const statuses = await checkDependencies();
      setDependencyStatuses(Object.fromEntries(statuses.map((status) => [status.id, status])));
    } catch (error) {
      setInstallMessage(`检查依赖失败：${String(error)}`);
    } finally {
      setCheckingDependencies(false);
    }
  };

  const install = async (id: string) => {
    setInstalling(id);
    setInstallMessage("");
    try {
      const result = await installDependency(id);
      setInstallMessage(result.message);
      await refreshDependencies();
    } catch (error) {
      setInstallMessage(String(error));
    } finally {
      setInstalling(null);
    }
  };

  useEffect(() => {
    void refreshDependencies();
  }, []);

  // ---- 模型提供商 ----

  /** 下拉里存的是 `provider/model` 引用，不是哪一项；指向失效时由 resolveDefaultModel 兜底 */
  const resolved = resolveDefaultModel(settings);
  const defaultRef = resolved?.ref ?? "";
  const modelOptions = modelRefOptions(settings);

  /** 改一条提供商，顺带把失效的默认指向写回落后的结果 */
  const applyProviders = (aiProviders: AiProvider[]) => {
    update({ aiProviders, ...defaultPatch({ ...settings, aiProviders }) });
  };

  const updateProvider = (index: number, next: AiProvider) => {
    applyProviders(settings.aiProviders.map((item, i) => (i === index ? next : item)));
  };

  const addProvider = () => {
    const next = emptyProvider(newProviderId("", settings.aiProviders));
    setOpenProvider(settings.aiProviders.length);
    update({ aiProviders: [...settings.aiProviders, next] });
  };

  /** 复制一份：id 必须重新生成，配置内容和模型跟着拷 */
  const duplicateProvider = (index: number) => {
    const source = settings.aiProviders[index];
    const id = newProviderId(`${source.id}-copy`, settings.aiProviders);
    const copy: AiProvider = {
      ...source,
      id,
      name: `${source.name || source.id} 副本`,
      models: source.models.map((model) => ({ ...model })),
    };
    const aiProviders = [...settings.aiProviders];
    aiProviders.splice(index + 1, 0, copy);
    setOpenProvider(index + 1);
    applyProviders(aiProviders);
  };

  /** 删之前先数一数有多少 Agent 绑在它身上：确认框得说清影响面 */
  const askRemoveProvider = (provider: AiProvider) => {
    setPendingRemove({ provider, refs: countAgentRefs(settings, provider.id) });
  };

  const removeProvider = (provider: AiProvider) => {
    setOpenProvider(null);
    applyProviders(settings.aiProviders.filter((item) => item.id !== provider.id));
    // 钥匙串里的条目跟着一起清：留着就是个永远不会再被用到的死条目，
    // 用户在系统凭据管理器里看到会以为还在用。删不掉也不拦——设置已经改完了，
    // 这里只是尽力收尾
    void deleteSecret(provider.id).catch(() => {});
  };

  const setDefaultProvider = (provider: AiProvider) => {
    const model = provider.models.find(
      (item) => item.enabled && item.id.trim() !== "",
    );
    if (!model) return;
    update({ aiDefaultProvider: provider.id, aiDefaultModel: model.id.trim() });
  };

  const updateDefaultModel = (ref: string) => {
    const cut = ref.indexOf("/");
    if (cut <= 0) {
      update({ aiDefaultProvider: "", aiDefaultModel: "" });
      return;
    }
    update({
      aiDefaultProvider: ref.slice(0, cut),
      aiDefaultModel: ref.slice(cut + 1),
    });
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // 确认框开着时 Esc 归它管（取消这一下），别顺手把整个设置面板也关了
      if (event.key === "Escape" && !confirmReset && !pendingRemove) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, confirmReset, pendingRemove]);

  const flipTab = (step: number) => {
    const next = TABS[TABS.findIndex((item) => item.id === tab) + step];
    if (!next) return;
    const now = Date.now();
    if (now - lastFlipRef.current < 320) return;
    lastFlipRef.current = now;
    setTab(next.id);
  };

  /** 滚到两头还接着滚，就翻到相邻的分类；内容不足一屏时两头都算到底，一格就翻 */
  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    if (event.deltaY > 0 && el.scrollTop + el.clientHeight >= el.scrollHeight - 1) {
      flipTab(1);
    } else if (event.deltaY < 0 && el.scrollTop <= 0) {
      flipTab(-1);
    }
  };

  /**
   * 量出弹窗此刻的位置和大小（相对遮罩左上角），顺便算出它能到达的范围。
   *
   * 可拖范围就是遮罩的内容区，内边距从计算样式里读，免得和 p-6 这个类名脱节。
   * 缩放和挪位置都要先量一次：居中布局交给 flex，得先把那一下的像素位置固化下来，
   * 否则一拖就跳。
   */
  const measureDialog = () => {
    const overlay = overlayRef.current;
    const dialog = dialogRef.current;
    if (!overlay || !dialog) return null;
    const rect = dialog.getBoundingClientRect();
    const pane = overlay.getBoundingClientRect();
    const styles = window.getComputedStyle(overlay);
    const padX = Number.parseFloat(styles.paddingLeft) || 0;
    const padY = Number.parseFloat(styles.paddingTop) || 0;
    return {
      start: {
        left: rect.left - pane.left,
        top: rect.top - pane.top,
        width: rect.width,
        height: rect.height,
      },
      bounds: { minX: padX, minY: padY, maxX: pane.width - padX, maxY: pane.height - padY },
    };
  };

  /** 按住边缘开始缩放 */
  const onResizeDown =
    (edges: ResizeEdges) => (event: ReactPointerEvent<HTMLDivElement>) => {
      const measured = measureDialog();
      if (!measured) return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);

      setBox(measured.start);
      resizeRef.current = {
        edges,
        startX: event.clientX,
        startY: event.clientY,
        start: measured.start,
        bounds: measured.bounds,
      };
    };

  const onResizeMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = resizeRef.current;
    if (!drag) return;
    const { edges, start, bounds } = drag;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    const next = { ...start };

    // 拖哪条边就钉住对面那条：先夹住被拖的边，另一边和尺寸由它反推
    if (edges.e) {
      next.width = clamp(DIALOG_MIN_WIDTH, start.width + dx, bounds.maxX - start.left);
    } else if (edges.w) {
      next.left = clamp(
        bounds.minX,
        start.left + dx,
        start.left + start.width - DIALOG_MIN_WIDTH,
      );
      next.width = start.left + start.width - next.left;
    }
    if (edges.s) {
      next.height = clamp(DIALOG_MIN_HEIGHT, start.height + dy, bounds.maxY - start.top);
    } else if (edges.n) {
      next.top = clamp(
        bounds.minY,
        start.top + dy,
        start.top + start.height - DIALOG_MIN_HEIGHT,
      );
      next.height = start.top + start.height - next.top;
    }
    setBox(next);
  };

  const onResizeUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizeRef.current) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    resizeRef.current = null;
  };

  /** 按住标题栏挪位置。整个弹窗都夹在遮罩内容区里，不会被拖出屏幕 */
  const onMoveDown = (event: ReactPointerEvent<HTMLElement>) => {
    // 标题栏里的关闭按钮要照常能点，别被拖拽抢走
    if ((event.target as HTMLElement).closest("button")) return;
    const measured = measureDialog();
    if (!measured) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setBox(measured.start);
    moveRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      start: measured.start,
      bounds: measured.bounds,
    };
  };

  const onMoveMove = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = moveRef.current;
    if (!drag) return;
    const { start, bounds } = drag;
    setBox({
      ...start,
      left: clamp(
        bounds.minX,
        start.left + event.clientX - drag.startX,
        bounds.maxX - start.width,
      ),
      top: clamp(
        bounds.minY,
        start.top + event.clientY - drag.startY,
        bounds.maxY - start.height,
      ),
    });
  };

  const onMoveUp = (event: ReactPointerEvent<HTMLElement>) => {
    if (!moveRef.current) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    moveRef.current = null;
  };

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      onClick={() => {
        // 确认框开着时，点它的遮罩只算取消那一下，别顺手把设置面板也关了
        if (!confirmReset) onClose();
      }}
    >
      {/* 尺寸写死：内容少的分类不缩、内容多就滚动，来回切 tab 面板不会跳大小。
          max-h-full 留着，窗口比面板还矮时还能压下来。
          拖动过之后由 box 接管成绝对定位，类名里的尺寸就成了初值 */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        style={
          box
            ? {
                position: "absolute",
                left: box.left,
                top: box.top,
                width: box.width,
                height: box.height,
              }
            : undefined
        }
        className="relative flex h-[620px] max-h-full w-[640px] max-w-full flex-col overflow-hidden rounded-xl border border-line-strong bg-raised shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        {/* 四边四角都能拖着改大小，热区压在最上层 */}
        {RESIZE_HANDLES.map((handle) => (
          <div
            key={handle.className}
            role="separator"
            aria-label="拖动调整窗口大小"
            onPointerDown={onResizeDown(handle.edges)}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeUp}
            onPointerCancel={onResizeUp}
            className={`absolute z-10 ${handle.className}`}
          />
        ))}
        {/* 标题栏兼作拖动把手；关闭按钮单独用 pointer 光标，别跟着变成移动光标 */}
        <header
          onPointerDown={onMoveDown}
          onPointerMove={onMoveMove}
          onPointerUp={onMoveUp}
          onPointerCancel={onMoveUp}
          className="flex h-11 shrink-0 cursor-move items-center border-b border-line px-4"
        >
          <span className="flex-1 text-[13px] font-semibold text-fg">设置</span>
          <button
            type="button"
            onClick={onClose}
            title="关闭"
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-fg-dim hover:bg-hover hover:text-fg"
          >
            <IconClose className="h-3.5 w-3.5" />
          </button>
        </header>

        <div className="flex min-h-0 flex-1">
          <nav className="flex w-28 shrink-0 flex-col gap-0.5 border-r border-line p-2">
            {TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={`rounded-md px-2.5 py-1.5 text-left text-[12px] ${
                  tab === item.id
                    ? "bg-selected text-fg"
                    : "text-fg-dim hover:bg-hover hover:text-fg"
                }`}
              >
                {item.label}
              </button>
            ))}
          </nav>

          {/* key 用 tab：切分类时容器重建，滚动位置跟着归零 */}
          <div
            key={tab}
            onWheel={onWheel}
            className="min-h-0 flex-1 overflow-auto"
          >
            <div className="flex flex-col gap-3.5 p-4">
              {tab === "appearance" && (
                <>
                  <Field label="主题">
                    <ThemeSelect />
                  </Field>
                  <p className="text-[11px] leading-relaxed text-fg-faint">
                    右边栏：关掉的模块不再出现在图标条上，至少留一个。
                  </p>
                  <Field label="文件">
                    <BoolToggle
                      value={settings.rightFilesVisible}
                      options={VISIBLE_OPTIONS}
                      disabledValue={lastVisible === "files" ? false : undefined}
                      onChange={(rightFilesVisible) => update({ rightFilesVisible })}
                    />
                  </Field>
                  <Field label="变更">
                    <BoolToggle
                      value={settings.rightChangesVisible}
                      options={VISIBLE_OPTIONS}
                      disabledValue={lastVisible === "changes" ? false : undefined}
                      onChange={(rightChangesVisible) => update({ rightChangesVisible })}
                    />
                  </Field>
                  <Field label="搜索">
                    <BoolToggle
                      value={settings.rightSearchVisible}
                      options={VISIBLE_OPTIONS}
                      disabledValue={lastVisible === "search" ? false : undefined}
                      onChange={(rightSearchVisible) => update({ rightSearchVisible })}
                    />
                  </Field>
                  <Field label="浏览器">
                    <BoolToggle
                      value={settings.rightBrowserVisible}
                      options={VISIBLE_OPTIONS}
                      disabledValue={lastVisible === "browser" ? false : undefined}
                      onChange={(rightBrowserVisible) => update({ rightBrowserVisible })}
                    />
                  </Field>
                  <Field
                    label="关闭窗口"
                    hint="开着项目时，关闭只收起界面让它在托盘里继续跑（终端、智能体不受影响）；要真退出请用托盘菜单"
                  >
                    <BoolToggle
                      value={settings.closeToTray}
                      options={CLOSE_OPTIONS}
                      onChange={(closeToTray) => update({ closeToTray })}
                    />
                  </Field>
                </>
              )}

              {tab === "terminal" && (
                <>
                  <Field
                    label="终端程序"
                    hint="只对新建的终端生效；已在运行的会话不受影响"
                  >
                    <TerminalShellSelect
                      value={settings.terminalShell}
                      onChange={(terminalShell) => update({ terminalShell })}
                    />
                  </Field>
                  <Field
                    label="配色主题"
                    hint="默认跟界面的深/浅色走；选了具体主题就固定下来"
                  >
                    <TerminalThemeSelect
                      value={settings.terminalTheme}
                      fallback={theme}
                      preference={palette}
                      onChange={(terminalTheme) => update({ terminalTheme })}
                    />
                  </Field>
                  <Field
                    label="字体"
                    hint={`CSS font-family，可写多个用逗号分隔；留空用 ${DEFAULT_MONO_FONT}`}
                  >
                    <input
                      type="text"
                      value={settings.terminalFontFamily}
                      spellCheck={false}
                      placeholder={DEFAULT_MONO_FONT}
                      onChange={(event) =>
                        update({ terminalFontFamily: event.target.value })
                      }
                      className={TEXT_INPUT}
                    />
                  </Field>
                  <Field label="字号">
                    <SizeSlider
                      value={settings.terminalFontSize}
                      onChange={(terminalFontSize) => update({ terminalFontSize })}
                    />
                  </Field>
                  <Field label="字重">
                    <BoolToggle
                      value={settings.terminalFontBold}
                      options={WEIGHT_OPTIONS}
                      onChange={(terminalFontBold) => update({ terminalFontBold })}
                    />
                  </Field>
                  <Field
                    label="AI CLI"
                    hint="名称只用于展示，命令用于在当前终端执行；空命令不会出现在工具条中"
                    action={
                      <button
                        type="button"
                        onClick={() =>
                          update({
                            aiCommands: [
                              ...settings.aiCommands,
                              { name: "", command: "" },
                            ],
                          })
                        }
                        title="添加一个 AI CLI"
                        className={HEAD_ACTION}
                      >
                        <IconPlus className="h-3 w-3" />
                      </button>
                    }
                  >
                    <div className="flex w-full flex-col gap-1.5">
                      {settings.aiCommands.map((item, index) => (
                        <div key={index} className="flex items-center gap-1.5">
                          <input
                            type="text"
                            value={item.name}
                            spellCheck={false}
                            placeholder="名称"
                            onChange={(event) =>
                              update({
                                aiCommands: settings.aiCommands.map((entry, i) =>
                                  i === index
                                    ? { ...entry, name: event.target.value }
                                    : entry,
                                ),
                              })
                            }
                            className={`${TEXT_INPUT} min-w-0 flex-1`}
                          />
                          <input
                            type="text"
                            value={item.command}
                            spellCheck={false}
                            placeholder="命令，例如 claude"
                            onChange={(event) =>
                              update({
                                aiCommands: settings.aiCommands.map((entry, i) =>
                                  i === index
                                    ? { ...entry, command: event.target.value }
                                    : entry,
                                ),
                              })
                            }
                            className={`${TEXT_INPUT} min-w-0 flex-[1.5]`}
                          />
                          <button
                            type="button"
                            onClick={() =>
                              update({
                                aiCommands: settings.aiCommands.filter(
                                  (_, i) => i !== index,
                                ),
                              })
                            }
                            title="删除这个 AI CLI"
                            className={LIST_ACTION}
                          >
                            <IconClose className="h-3 w-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </Field>
                </>
              )}

              {tab === "editor" && (
                <>
                  <Field
                    label="字体"
                    hint={`CSS font-family，可写多个用逗号分隔；留空用 ${DEFAULT_MONO_FONT}`}
                  >
                    <input
                      type="text"
                      value={settings.editorFontFamily}
                      spellCheck={false}
                      placeholder={DEFAULT_MONO_FONT}
                      onChange={(event) =>
                        update({ editorFontFamily: event.target.value })
                      }
                      className={TEXT_INPUT}
                    />
                  </Field>
                  <Field label="字号">
                    <SizeSlider
                      value={settings.editorFontSize}
                      onChange={(editorFontSize) => update({ editorFontSize })}
                    />
                  </Field>
                  <Field label="字重">
                    <BoolToggle
                      value={settings.editorFontBold}
                      options={WEIGHT_OPTIONS}
                      onChange={(editorFontBold) => update({ editorFontBold })}
                    />
                  </Field>
                  <Field
                    label="自动保存"
                    hint="四种时机照 VS Code 来；有未保存改动的文件都会写回磁盘"
                  >
                    <Select
                      value={settings.editorAutoSave}
                      options={AUTO_SAVE_OPTIONS}
                      onChange={(editorAutoSave) => update({ editorAutoSave })}
                    />
                  </Field>
                  {settings.editorAutoSave === "afterDelay" && (
                    <Field label="自动保存延迟" hint="停手多久之后落盘">
                      <input
                        type="number"
                        min={AUTOSAVE_DELAY_MIN}
                        max={AUTOSAVE_DELAY_MAX}
                        step={100}
                        value={settings.editorAutoSaveDelay}
                        onChange={(event) =>
                          update({
                            editorAutoSaveDelay: Number(event.target.value),
                          })
                        }
                        className={TEXT_INPUT}
                      />
                      <span className="shrink-0 text-[12px] text-fg-dim">毫秒</span>
                    </Field>
                  )}
                </>
              )}

              {tab === "dependencies" && (
                <>
                  <Section
                    title="基础运行环境"
                    hint="这些工具用于文件变更、终端和本机 AI 命令。已安装的项目会显示版本。"
                    action={
                      <span className="text-[11px] text-fg-faint">
                        {Object.values(dependencyStatuses).filter((status) => status.installed).length}/7 已就绪
                      </span>
                    }
                  >
                    <DependencyRow
                      id="git"
                      label="Git"
                      detail="文件变更、暂存、提交和历史记录"
                      installing={installing === "git"}
                      checking={checkingDependencies}
                      status={dependencyStatuses.git}
                      onInstall={install}
                    />
                    <DependencyRow
                      id="node"
                      label="Node.js"
                      detail="运行 npm 和各类 JavaScript CLI"
                      installing={installing === "node"}
                      checking={checkingDependencies}
                      status={dependencyStatuses.node}
                      onInstall={install}
                    />
                  </Section>

                  <Section
                    title="AI 命令行工具"
                    hint="按需安装；安装后可在终端中使用，也可加入顶部的 CLI 列表。"
                  >
                    <DependencyRow
                      id="opencode"
                      label="opencode"
                      detail="npm install -g @opencode/cli"
                      installing={installing === "opencode"}
                      checking={checkingDependencies}
                      status={dependencyStatuses.opencode}
                      onInstall={install}
                    />
                    <DependencyRow
                      id="codex"
                      label="Codex"
                      detail="npm install -g @openai/codex"
                      installing={installing === "codex"}
                      checking={checkingDependencies}
                      status={dependencyStatuses.codex}
                      onInstall={install}
                    />
                    <DependencyRow
                      id="codebuddy"
                      label="CodeBuddy"
                      detail="npm install -g @tencent-ai/codebuddy-code"
                      installing={installing === "codebuddy"}
                      checking={checkingDependencies}
                      status={dependencyStatuses.codebuddy}
                      onInstall={install}
                    />
                    <DependencyRow
                      id="claude"
                      label="Claude Code"
                      detail="npm install -g @anthropic-ai/claude-code"
                      installing={installing === "claude"}
                      checking={checkingDependencies}
                      status={dependencyStatuses.claude}
                      onInstall={install}
                    />
                  </Section>

                  <Section
                    title="可选扩展"
                    hint="只在使用 CodeDock 的 Gitee 反馈功能时需要。"
                  >
                    <DependencyRow
                      id="gitee"
                      label="Gitee CLI"
                      detail="npm install -g @gitee/gitee-cli"
                      installing={installing === "gitee"}
                      checking={checkingDependencies}
                      status={dependencyStatuses.gitee}
                      onInstall={install}
                    />
                  </Section>
                  {installMessage && (
                    <p className="whitespace-pre-wrap text-[11px] leading-relaxed text-fg-faint">
                      {installMessage}
                    </p>
                  )}
                  <p className="text-[11px] leading-relaxed text-fg-faint">
                    Windows 的 WebView2 由系统提供；如果应用无法启动，请先安装 Microsoft Edge WebView2 Runtime。
                  </p>
                </>
              )}

              {tab === "agent" && (
                <>
                  <Section
                    title="模型提供商"
                    hint="OpenAI 兼容的服务都能接入，一家一条；智能体和「变更」里的提交信息生成都读这里"
                    action={
                      <button
                        type="button"
                        title="新增提供商"
                        onClick={addProvider}
                        className={HEAD_ACTION}
                      >
                        <IconPlus className="h-3.5 w-3.5" />
                      </button>
                    }
                  >
                    <div className="flex w-full flex-col gap-2">
                      {settings.aiProviders.length === 0 ? (
                        <p className="text-[11px] text-fg-faint">
                          还没有提供商。点右上角的加号加一条，填好接口地址和至少一个模型。
                        </p>
                      ) : (
                        settings.aiProviders.map((provider, index) => (
                          <ProviderEditor
                            key={provider.id}
                            provider={provider}
                            open={openProvider === index}
                            isDefault={
                              resolveDefaultModel(settings)?.providerId === provider.id
                            }
                            secretStoreError={secretNotice}
                            onToggle={() =>
                              setOpenProvider(openProvider === index ? null : index)
                            }
                            onChange={(next) => updateProvider(index, next)}
                            onSetDefault={() => setDefaultProvider(provider)}
                            onDuplicate={() => duplicateProvider(index)}
                            onRemove={() => askRemoveProvider(provider)}
                          />
                        ))
                      )}
                      {overriddenAi.length > 0 && (
                        <p className="text-[11px] leading-relaxed text-fg-faint">
                          开发调试：src-tauri/.env 覆盖了「{overriddenAi.join("、")}」，
                          它们会顶掉「默认提供商」的接口地址、模型和密钥（密钥不再走钥匙串，
                          直接注入子进程环境）。改完重开应用生效；已在跑的智能体要停掉再起。
                        </p>
                      )}
                    </div>
                  </Section>

                  <Section
                    title="默认模型"
                    hint="新会话默认用它；单个 Agent 可以在下面单独绑定别的"
                  >
                    <Field
                      label="全局默认"
                      hint={
                        settings.aiProviders.length === 0
                          ? "先去上面加一个提供商"
                          : "选项来自已启用的提供商和模型"
                      }
                    >
                      <Select
                        value={defaultRef}
                        options={[
                          { value: "", label: "未配置" },
                          ...modelRefOptions(settings),
                        ]}
                        onChange={(next) => updateDefaultModel(next)}
                      />
                    </Field>
                  </Section>

                  <Section
                    title="运行"
                    hint="终端区顶栏的 GUI tab 里起一个 headless opencode，需要单独安装"
                  >
                    <Field label="智能体（GUI）">
                      <BoolToggle
                        value={settings.agentEnabled}
                        options={[
                          { value: true, label: "开启" },
                          { value: false, label: "关闭" },
                        ]}
                        onChange={(next) => update({ agentEnabled: next })}
                      />
                    </Field>
                    <Field
                      label="opencode 可执行文件"
                      hint="填裸命令名会去 PATH 里找；找不到时填完整路径。改完下次启动才生效"
                    >
                      <input
                        type="text"
                        value={settings.agentCommand}
                        spellCheck={false}
                        placeholder="opencode"
                        onChange={(event) => update({ agentCommand: event.target.value })}
                        className={TEXT_INPUT}
                      />
                    </Field>
                    <Field
                      label="服务端口"
                      hint="0 表示自动挑一个空闲端口；填固定值要保证没被别的程序占用"
                    >
                      <input
                        type="number"
                        min={0}
                        max={65535}
                        value={settings.agentPort}
                        onChange={(event) => update({ agentPort: Number(event.target.value) })}
                        className={TEXT_INPUT}
                      />
                    </Field>
                  </Section>

                  <Section
                    title="指令与扩展"
                    hint={
                      agentScope === "project" && !cwd
                        ? "先打开一个工作区，才能编辑项目层"
                        : "启动时注入 / 加载；项目层覆盖同名全局项，改动下次启动生效"
                    }
                    action={
                      <div className="flex shrink-0 gap-0.5 rounded-lg border border-line-strong p-0.5">
                        {(["global", "project"] as const).map((scope) => {
                          const disabled = scope === "project" && !cwd;
                          return (
                            <button
                              key={scope}
                              type="button"
                              disabled={disabled}
                              onClick={() => setAgentScope(scope)}
                              className={`rounded-md px-2.5 py-0.5 text-[12px] ${
                                agentScope === scope
                                  ? "bg-selected text-fg"
                                  : "text-fg-dim hover:bg-hover hover:text-fg"
                              } ${
                                disabled
                                  ? "cursor-not-allowed opacity-40 hover:bg-transparent"
                                  : ""
                              }`}
                            >
                              {scope === "global" ? "全局" : "本项目"}
                            </button>
                          );
                        })}
                      </div>
                    }
                  >
                    <LayerEditor
                      layer={
                        agentScope === "global"
                          ? settings.agentGlobal
                          : projectLayer(settings, cwd)
                      }
                      modelOptions={modelOptions}
                      onChange={(next) => update(withLayer(settings, agentScope, cwd, next))}
                    />
                  </Section>
                </>
              )}
            </div>
          </div>
        </div>

        {/* 恢复默认沉在底部：它管的是所有分类，放某个 tab 里会让人以为只重置那一页。
            左上角顺手显示版本，装完能自己核对（dev 构建额外带个标记） */}
        <footer className="flex h-12 shrink-0 items-center justify-between border-t border-line px-4">
          <span className="select-text text-[11px] text-fg-faint">
            CodeDock v{__APP_VERSION__}
            {import.meta.env.DEV ? " (dev)" : ""}
          </span>
          <button
            type="button"
            onClick={() => setConfirmReset(true)}
            className={RESET_BUTTON}
          >
            恢复默认设置
          </button>
        </footer>
      </div>

      {/* 挂在卡片外面、但仍在遮罩里：确认框的遮罩接住点击，冒到这一层时被上面的
          `confirmReset` 挡掉，不会连设置面板一起关 */}
      {pendingRemove && (
        <ConfirmDialog
          message={
            pendingRemove.refs > 0
              ? `删除提供商「${pendingRemove.provider.name || pendingRemove.provider.id}」？${
                  pendingRemove.refs
                } 个 Agent 绑在它的模型上，删掉后那些 Agent 会回落成跟随全局默认。`
              : `删除提供商「${
                  pendingRemove.provider.name || pendingRemove.provider.id
                }」？它的模型配置会一起去掉，无法撤销。`
          }
          confirmLabel="删除"
          onConfirm={() => {
            removeProvider(pendingRemove.provider);
            setPendingRemove(null);
          }}
          onCancel={() => setPendingRemove(null)}
        />
      )}

      {confirmReset && (
        <ConfirmDialog
          message="恢复默认设置？模型提供商、密钥、AI CLI 列表、字体、主题和右栏模块都会回到初始值，无法撤销。"
          confirmLabel="恢复默认"
          onConfirm={() => {
            reset();
            setPreference(DEFAULT_THEME);
            setConfirmReset(false);
          }}
          onCancel={() => setConfirmReset(false)}
        />
      )}
    </div>
  );
}
