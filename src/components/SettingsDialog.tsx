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
  DEFAULT_UI_FONT,
  resolveFont,
  type AgentEnvVar,
  type AiCommand,
  type AiProvider,
  type AutoSaveMode,
  type EditorIndent,
  type EditorLineHeight,
  type ProviderModel,
  type Settings,
  type SettingsSection,
} from "../lib/settings";
import {
  emptyModel,
  emptyProvider,
  modelRefOptions,
  newProviderId,
  resolveDefaultModel,
} from "../lib/providers";
import {
  AGENT_CATALOG,
  catalogStatusId,
  checkAgentClis,
  commandStatusId,
  configuredIndex,
  type AgentCatalogItem,
  type AgentCliStatus,
} from "../lib/agents";
import { acpProviderKey } from "../lib/acp";
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
  SHORTCUT_COMMANDS,
  formatShortcut,
  setShortcutRecording,
  shortcutFromEvent,
} from "../lib/shortcuts";
import {
  checkDependencies,
  installDependency,
  type DependencyStatus,
} from "../lib/installer";
import { RIGHT_TOOLS } from "./ToolRail";
import type { ToolId } from "./ToolPane";
import type { TranslateTarget } from "../lib/types";
import { ConfirmDialog } from "./ConfirmDialog";
import {
  AgentLogo,
  IconBot,
  IconCheck,
  IconChevronDown,
  IconClose,
  IconCopy,
  IconDownload,
  IconGripVertical,
  IconKeyboard,
  IconPalette,
  IconPencil,
  IconPlus,
  IconRefresh,
  IconSettings,
  IconSparkle,
  IconTerminal,
} from "./icons";

interface SettingsDialogProps {
  onClose: () => void;
}

/** 分类靠左边的竖排 tab，内容区一次只显示一组。desc 作为内容区页头的一句话说明 */
const TABS = [
  {
    id: "appearance",
    label: "外观",
    desc: "主题配色、界面字体与右栏模块",
    icon: IconPalette,
  },
  {
    id: "terminal",
    label: "终端",
    desc: "终端程序、配色方案与等待提示",
    icon: IconTerminal,
  },
  {
    id: "editor",
    label: "编辑器",
    desc: "排版方式、缩进与保存行为",
    icon: IconPencil,
  },
  {
    id: "shortcuts",
    label: "快捷键",
    desc: "为应用命令录制自定义键位",
    icon: IconKeyboard,
  },
  {
    id: "agents",
    label: "智能体",
    desc: "编程 Agent 的安装状态、启动命令与环境变量",
    icon: IconBot,
  },
  {
    id: "agent",
    label: "模型",
    desc: "模型提供商、文档翻译与助手服务",
    icon: IconSparkle,
  },
  {
    id: "dependencies",
    label: "依赖",
    desc: "检查并安装运行所需的命令行工具",
    icon: IconDownload,
  },
] as const;

type TabId = (typeof TABS)[number]["id"];

/** 「恢复本页默认」确认框里，逐页说清会重置哪些东西 */
const SECTION_RESET_HINT: Record<SettingsSection, string> = {
  appearance: "主题、界面 / 终端 / 编辑器字体，以及右栏模块显隐、启动恢复和关闭窗口行为",
  terminal: "终端程序与配色",
  agents: "编程 Agent 列表，含名称、启动命令与环境变量",
  editor: "缩进宽度、缩略图、自动换行、自动保存，以及保存时的格式化与语法校验",
  shortcuts: "全部快捷键键位",
  agent: "模型提供商、密钥与文档翻译目标语言",
};

/** 依赖页只有环境检测与安装，没有可恢复的设置项 */
function isResettableTab(tab: TabId): tab is SettingsSection {
  return tab !== "dependencies";
}

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
  { value: "solarized-dark", label: "Solarized Dark", swatch: ["#002b36", "#93a1a1"] },
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

/** 通用的开 / 关（启动恢复、minimap 这类没有更贴切措辞的布尔项） */
const ON_OFF_OPTIONS: { value: boolean; label: string }[] = [
  { value: true, label: "开启" },
  { value: false, label: "关闭" },
];

/** 开着工作区时关窗口：直接收进托盘，还是每次都问一句 */
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

/** 文档翻译目标语言；只支持中英，翻译视图里也能切换 */
const TRANSLATE_TARGET_OPTIONS: { value: TranslateTarget; label: string }[] = [
  { value: "zh", label: "简体中文" },
  { value: "en", label: "English" },
];

/** 编辑器缩进宽度；auto 交回 Monaco 按文件内容探测 */
const INDENT_OPTIONS: { value: EditorIndent; label: string }[] = [
  { value: "auto", label: "按文件内容自动探测" },
  { value: "2", label: "2 空格" },
  { value: "4", label: "4 空格" },
  { value: "8", label: "8 空格" },
];

/** 行高三档：值是**倍数**，直接交给 Monaco 的 lineHeight（小于 8 时它按字号倍数解释） */
const LINE_HEIGHT_OPTIONS: { value: EditorLineHeight; label: string }[] = [
  { value: "1.4", label: "紧凑（1.4 倍）" },
  { value: "1.6", label: "默认（1.6 倍）" },
  { value: "1.8", label: "宽松（1.8 倍）" },
];

const TEXT_INPUT =
  "w-full rounded-lg border border-line-strong bg-surface px-2.5 py-1.5 text-[12px] text-fg outline-none transition-colors placeholder:text-fg-faint hover:border-line-hover focus:border-accent focus:ring-2 focus:ring-accent/15";

const LIST_ACTION =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-fg-faint transition-colors hover:bg-hover hover:text-danger";

/** 分组标题右端的行内操作按钮，和列表里的删除按钮同一套视觉 */
const HEAD_ACTION =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-fg-faint transition-colors hover:bg-hover hover:text-fg";

/** 设置页里的次级按钮：描边、悬停才染色，避免满屏都是实心按钮 */
const BUTTON =
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-line-strong px-2.5 py-1 text-[12px] text-fg-muted transition-colors hover:border-line-hover hover:bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-line-strong disabled:hover:bg-transparent disabled:hover:text-fg-muted";

const BUTTON_SM =
  "inline-flex shrink-0 items-center justify-center gap-1 rounded-md border border-line-strong px-2 py-1 text-[11px] text-fg-muted transition-colors hover:border-line-hover hover:bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-line-strong disabled:hover:bg-transparent disabled:hover:text-fg-muted";

const BUTTON_DANGER =
  "inline-flex shrink-0 items-center justify-center gap-1 rounded-md border border-line-strong px-2 py-1 text-[11px] text-fg-muted transition-colors hover:border-danger-line hover:bg-danger-bg hover:text-danger disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-line-strong disabled:hover:bg-transparent disabled:hover:text-fg-muted";

const BUTTON_PRIMARY =
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-accent-line bg-accent/10 px-2.5 py-1 text-[12px] text-accent-soft transition-colors hover:bg-accent/15 disabled:cursor-not-allowed disabled:opacity-40";

/** 底部的「恢复默认设置」：描边按钮，悬停才透出危险色——它会把密钥和 CLI 列表一起清掉 */
const RESET_BUTTON =
  "rounded-lg border border-line-strong px-2.5 py-1 text-[12px] text-fg-muted transition-colors hover:border-danger-line hover:bg-danger-bg hover:text-danger";

/** 两次边界滚轮事件间隔小于它，就当作触控板的同一次惯性滑动：只有停手后再滑才算新的一下 */
const EDGE_GAP_MS = 200;

/** 拖动把手要挪过这么多像素才算「真在拖」，否则只当是手抖 */
const DRAG_THRESHOLD = 4;

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
        <span className="min-w-0 flex-1 text-[12px] font-medium text-fg-muted">{label}</span>
        {action}
      </div>
      <div className="flex items-center gap-2">{children}</div>
      {hint && <p className="text-[11px] leading-relaxed text-fg-faint">{hint}</p>}
    </div>
  );
}

/** 一行设置：左标签、右控件。外观页那种成片的短选项用它，比「标签在上、控件在下」的
    Field 省一半高度。控件区 flex-1：输入框 / 滑杆自然铺满，分段开关靠 justify-end 贴右，
    几行看下来控件落在同一条竖线上。hint 缩进到与控件对齐，挂在行下方。 */
function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-3">
        <span className="w-24 shrink-0 text-[12px] text-fg-muted">{label}</span>
        <div className="flex min-w-0 flex-1 items-center justify-end gap-2">{children}</div>
      </div>
      {hint && <p className="pl-[108px] text-[11px] leading-relaxed text-fg-faint">{hint}</p>}
    </div>
  );
}

/** 设置页里的一组字段：标题 + 说明 +（可选）右侧操作，字段收进一张浅色卡片里，
    长页面也能按块扫读。标题右侧留一条细线，把操作按钮和标题连成同一行。 */
function Section({
  title,
  hint,
  action,
  dense,
  children,
}: {
  title: string;
  hint?: string;
  /** 放标题行右端，例如作用域切换 */
  action?: ReactNode;
  /** 子项是紧凑的单行 Row 时收紧行距（外观页那种成片的短选项） */
  dense?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-col gap-1 px-0.5">
        <div className="flex min-h-6 items-center gap-2">
          <h3 className="shrink-0 text-[12px] font-semibold tracking-wide text-fg">{title}</h3>
          <span className="h-px min-w-2 flex-1 bg-line" />
          {action}
        </div>
        {hint && <p className="text-[11px] leading-relaxed text-fg-faint">{hint}</p>}
      </div>
      <div
        className={`flex flex-col rounded-xl border border-line bg-surface/50 p-3.5 ${
          dense ? "gap-2.5" : "gap-3.5"
        }`}
      >
        {children}
      </div>
    </section>
  );
}

/** 录制式键位控件：点一下进入录制，按下目标组合键即捕获；Esc 取消，冲突时留在录制态 */
function ShortcutRecorder({
  combo,
  onRecord,
}: {
  combo: string;
  /** 返回错误信息表示被拒（如与别的命令冲突）；返回 null 表示已接受 */
  onRecord: (next: string) => string | null;
}) {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState("");
  const buttonRef = useRef<HTMLButtonElement>(null);
  // 用 ref 存最新回调：父组件每次渲染都会传新函数，进了依赖数组会反复解绑重挂
  const recordRef = useRef(onRecord);
  recordRef.current = onRecord;

  useEffect(() => {
    if (!recording) return;
    // 让全局快捷键分发让路：它的 window 监听注册得比这里早（见 lib/shortcuts.ts）
    setShortcutRecording(true);
    const onKeyDown = (event: KeyboardEvent) => {
      // 录制期间吃掉所有按键，别让它们去触发别的快捷键或输入
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setRecording(false);
        setError("");
        return;
      }
      const next = shortcutFromEvent(event);
      if (!next) return; // 纯修饰键 / 保留键：继续等目标键
      const message = recordRef.current(next);
      if (message) {
        setError(message);
        return;
      }
      setError("");
      setRecording(false);
    };
    const onBlur = () => {
      setRecording(false);
      setError("");
    };
    // 点到别处就退出录制：否则点到另一个录制控件会同时挂两份监听，按键被处理两遍
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (buttonRef.current && target instanceof Node && buttonRef.current.contains(target)) {
        return;
      }
      setRecording(false);
      setError("");
    };
    // 捕获阶段挂到 window：录制期间焦点在哪都收得到，也抢在设置面板的 Esc 关弹窗之前
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      setShortcutRecording(false);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [recording]);

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <button
        type="button"
        ref={buttonRef}
        onClick={() => {
          setRecording((current) => !current);
          setError("");
        }}
        className={`min-w-32 rounded-lg border bg-surface px-2.5 py-1.5 text-left text-[12px] transition-colors ${
          recording
            ? "border-accent text-accent ring-2 ring-accent/15"
            : "border-line-strong text-fg hover:border-line-hover"
        }`}
      >
        {recording ? "按下组合键…" : formatShortcut(combo)}
      </button>
      {error && <span className="shrink-0 text-[11px] text-danger">{error}</span>}
    </div>
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
        className="codovo-range min-w-0 flex-1"
      />
      <span className="w-11 shrink-0 rounded-md bg-hover px-1 py-0.5 text-center text-[11px] text-fg-dim tabular-nums">
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
    <div className="flex shrink-0 gap-0.5 rounded-lg border border-line-strong bg-surface/60 p-0.5">
      {options.map((option) => {
        const disabled = option.value === disabledValue;
        return (
          <button
            key={option.label}
            type="button"
            onClick={() => onChange(option.value)}
            disabled={disabled}
            className={`rounded-md px-2.5 py-1 text-[12px] transition-colors ${
              value === option.value
                ? "bg-selected text-fg shadow-sm"
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
    <div
      className="relative w-full"
      // 设置面板在 window 上也监听 Esc 关整个面板：下拉开着时拦一下，只关下拉
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
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
          {/* 滚轮别冒泡到内容区：否则会连带滚动设置项、到边界还会翻分类。
              overscroll-contain 再挡住浮层滚到底后的链式滚动 */}
          <div
            onWheel={(event) => event.stopPropagation()}
            className="absolute top-full left-0 z-40 mt-1 flex max-h-64 w-full flex-col gap-px overflow-auto overscroll-contain rounded-lg border border-line-strong bg-raised p-1 shadow-2xl"
          >
            {options.map((item) => (
              <button
                key={item.value}
                type="button"
                onClick={() => {
                  setOpen(false);
                  onChange(item.value);
                }}
                className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12px] transition-colors ${
                  value === item.value
                    ? "bg-selected text-fg"
                    : "text-fg-muted hover:bg-hover hover:text-fg"
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
      className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12px] transition-colors ${
        value === key ? "bg-selected text-fg" : "text-fg-muted hover:bg-hover hover:text-fg"
      }`}
    >
      {swatch(key)}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {value === key && <IconCheck className="h-3.5 w-3.5 shrink-0 text-accent" />}
    </button>
  );

  return (
    <div
      className="relative w-full"
      // 设置面板在 window 上也监听 Esc 关整个面板：下拉开着时拦一下，只关下拉
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
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
          {/* 滚轮别冒泡到内容区：否则会连带滚动设置项、到边界还会翻分类。
              overscroll-contain 再挡住浮层滚到底后的链式滚动 */}
          <div
            onWheel={(event) => event.stopPropagation()}
            className="absolute top-full left-0 z-40 mt-1 flex max-h-64 w-full flex-col gap-px overflow-auto overscroll-contain rounded-lg border border-line-strong bg-raised p-1 shadow-2xl"
          >
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
            onWheel={(event) => event.stopPropagation()}
            className="absolute top-full left-0 z-40 mt-1 flex max-h-72 w-full flex-col gap-px overflow-auto overscroll-contain rounded-lg border border-line-strong bg-raised p-1 shadow-2xl"
          >
            {THEME_OPTIONS.map((item, index) => (
              <button
                key={item.value}
                type="button"
                role="option"
                aria-selected={preference === item.value}
                onMouseEnter={() => highlight(index)}
                onClick={() => pick(item.value)}
                className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12px] transition-colors ${
                  preference === item.value
                    ? "bg-selected text-fg"
                    : activeIndex === index
                      ? "bg-hover text-fg"
                      : "text-fg-muted hover:bg-hover hover:text-fg"
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
const DIALOG_MIN_WIDTH = 520;
const DIALOG_MIN_HEIGHT = 380;

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

/** 一条技能的启用开关。用自绘滑块，省得给 checkbox 单独写样式 */
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
      className={`flex h-5 w-9 shrink-0 items-center rounded-full px-0.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
        checked ? "bg-accent-strong" : "bg-active hover:bg-line-strong"
      }`}
    >
      <span
        className={`h-4 w-4 rounded-full bg-app shadow-sm transition-transform ${
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
 * 一次塞进去会把设置里这一节和下发配置都撑爆。所以先看、再挑。
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
    <div className="flex w-full flex-col gap-2.5 rounded-lg border border-line-strong bg-raised p-2.5">
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
          className={BUTTON_SM}
        >
          {selectable.length > 0 && selectable.every((id) => picked.has(id))
            ? "全不选"
            : "全选"}
        </button>
      </div>

      <div className="flex max-h-56 min-h-0 flex-col overflow-y-auto rounded-lg border border-line bg-surface">
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
                className={`flex items-center gap-2 px-2.5 py-1.5 text-left transition-colors ${
                  added ? "cursor-not-allowed opacity-50" : "hover:bg-hover"
                }`}
              >
                <span
                  className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border transition-colors ${
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
        <button type="button" onClick={onCancel} className={BUTTON}>
          取消
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={picked.size === 0}
          className={BUTTON_PRIMARY}
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
    <div className="w-full overflow-hidden rounded-lg border border-line-strong bg-raised transition-colors">
      <div className="flex items-center gap-1.5 p-2.5">
        <CollapseHeader
          open={open}
          onToggle={onToggle}
          placeholder="未命名提供商"
          label={provider.name}
        />
        {isDefault && (
          <span className="shrink-0 rounded-md bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent-soft ring-1 ring-accent/20">
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
        <div className="flex flex-col gap-3 border-t border-line p-3">
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
              明文不写进设置；本地模型可以留空"
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
              className={BUTTON_SM}
            >
              {revealKey ? "隐藏" : "显示"}
            </button>
            <button
              type="button"
              onClick={() => void saveKey()}
              disabled={busy || draftKey.trim() === "" || secretStoreError !== ""}
              title={secretStoreError !== "" ? secretStoreError : "写进系统钥匙串"}
              className={BUTTON_SM}
            >
              保存
            </button>
            {provider.apiKeySet && (
              <button
                type="button"
                onClick={() => void clearKey()}
                disabled={busy}
                title="从系统钥匙串删掉这个提供商的密钥"
                className={BUTTON_DANGER}
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
              className={BUTTON}
            >
              {busy ? "测试中…" : "测试连接"}
            </button>
            {!isDefault && (
              <button
                type="button"
                onClick={onSetDefault}
                disabled={missing}
                title={missing ? "先填接口地址、并至少启用一个模型" : "设为全局默认"}
                className={BUTTON}
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
  onInstall?: (id: string) => void;
}) {
  const installed = status?.installed === true;
  return (
    <div
      className={`group flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors ${
        "border-line bg-raised/70 hover:border-line-hover hover:bg-raised"
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
      ) : onInstall ? (
        <button
          type="button"
          disabled={checking || installing}
          onClick={() => onInstall(id)}
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-line-strong px-2.5 py-1.5 text-[12px] text-fg-muted transition-colors hover:border-accent-line hover:bg-hover hover:text-fg disabled:cursor-wait disabled:opacity-50"
        >
          {checking ? "检查中…" : installing ? "安装中…" : "安装"}
        </button>
      ) : (
        <span className="shrink-0 text-[11px] text-fg-faint">需手动安装</span>
      )}
    </div>
  );
}

/** 安装状态徽标：绿=已安装，红=未安装，灰=还在检测 */
function AgentStatusBadge({
  status,
  checking,
}: {
  status?: AgentCliStatus;
  checking: boolean;
}) {
  if (!status) {
    return (
      <span className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] text-fg-faint">
        {checking ? "检测中…" : "未检测"}
      </span>
    );
  }
  return status.installed ? (
    <span
      title={status.version ?? "已安装"}
      className="shrink-0 rounded-full bg-ok/10 px-1.5 py-0.5 text-[10px] font-medium text-ok"
    >
      已安装
    </span>
  ) : (
    <span
      title="在 PATH 里找不到这个可执行文件"
      className="shrink-0 rounded-full bg-danger-bg px-1.5 py-0.5 text-[10px] font-medium text-danger"
    >
      未安装
    </span>
  );
}

/**
 * 环境变量编辑器：一行一个键值对，允许先加空行再慢慢填。
 *
 * 空键的行只存在界面上，启动时由 agentEnvFor 过滤；值会明文落在本机设置里，
 * 所以提示里写清楚——密钥类的还是建议交给 CLI 自己的配置文件。
 */
function EnvVarEditor({
  env,
  onChange,
}: {
  env: AgentEnvVar[];
  onChange: (next: AgentEnvVar[]) => void;
}) {
  const patch = (index: number, part: Partial<AgentEnvVar>) =>
    onChange(env.map((entry, i) => (i === index ? { ...entry, ...part } : entry)));

  return (
    <div className="flex w-full flex-col gap-1.5">
      {env.length === 0 && (
        <p className="text-[11px] text-fg-faint">还没有环境变量</p>
      )}
      {env.map((entry, index) => (
        <div key={index} className="flex items-center gap-1.5">
          <input
            type="text"
            value={entry.key}
            spellCheck={false}
            placeholder="变量名，如 ANTHROPIC_BASE_URL"
            onChange={(event) => patch(index, { key: event.target.value })}
            className={TEXT_INPUT + " min-w-0 flex-1 font-mono"}
          />
          <span className="shrink-0 text-[11px] text-fg-faint">=</span>
          <input
            type="text"
            value={entry.value}
            spellCheck={false}
            placeholder="值"
            onChange={(event) => patch(index, { value: event.target.value })}
            className={TEXT_INPUT + " min-w-0 flex-[1.3] font-mono"}
          />
          <button
            type="button"
            onClick={() => onChange(env.filter((_, i) => i !== index))}
            title="删除这个环境变量"
            className={LIST_ACTION}
          >
            <IconClose className="h-3 w-3" />
          </button>
        </div>
      ))}
      <div>
        <button
          type="button"
          onClick={() => onChange([...env, { key: "", value: "" }])}
          className={BUTTON_SM}
        >
          <IconPlus className="h-3 w-3" />
          添加变量
        </button>
      </div>
    </div>
  );
}

/**
 * 已配置的编程 Agent：一张可折叠卡片，头部是抓握把手 + 名字 + 安装状态，展开后改名称、
 * 启动命令和环境变量。
 *
 * 顺序就是终端顶栏 AI CLI 按钮的顺序，所以保留拖动重排；拖动只从把手发起，否则在输入框
 * 里划选文字会变成拖行。pointermove / pointerup 挂 window，指针移出把手也不会断。
 */
function AgentCommandList({
  commands,
  statuses,
  checking,
  openIndex,
  onOpenChange,
  onChange,
}: {
  commands: AiCommand[];
  statuses: Record<string, AgentCliStatus>;
  checking: boolean;
  openIndex: number | null;
  onOpenChange: (index: number | null) => void;
  onChange: (next: AiCommand[]) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ from: number; startY: number; started: boolean } | null>(null);
  const [pending, setPending] = useState(false);
  /** 正在被拖的那一行；null 表示没在拖 */
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  /** 落点空档的下标（0..n）；null 表示没在拖 */
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const dropRef = useRef<number | null>(null);
  // 拖动期间列表可能被别处改（比如同时还在编辑输入框），落盘时取最新一份
  const commandsRef = useRef(commands);
  commandsRef.current = commands;
  // 用 ref 存最新回调：父组件每次渲染都会传新函数，进了依赖数组会反复解绑重挂
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // 拖动后展开的条目会跟着换下标，得知道当前展开的是哪一条
  const openRef = useRef(openIndex);
  openRef.current = openIndex;
  const onOpenRef = useRef(onOpenChange);
  onOpenRef.current = onOpenChange;

  /** 光标落在第几个空档：逐行比中线，过了最后一行中线就落到末尾 */
  const dropIndexAt = (clientY: number): number => {
    const rows = listRef.current
      ? (Array.from(listRef.current.children) as HTMLElement[])
      : [];
    for (let i = 0; i < rows.length; i += 1) {
      const rect = rows[i].getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return i;
    }
    return rows.length;
  };

  /** 把手按下：只记起点，「到底在不在拖」交给 window 上的 pointermove 判 */
  const onHandleDown = (index: number) => (event: ReactPointerEvent<HTMLDivElement>) => {
    // 只认鼠标左键：触摸的纵向拖动要留给面板滚动
    if (event.button !== 0 || event.pointerType !== "mouse") return;
    // 挡住默认行为，免得按住把手就开始选文本
    event.preventDefault();
    dragRef.current = { from: index, startY: event.clientY, started: false };
    setPending(true);
  };

  useEffect(() => {
    if (!pending) return;
    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (!drag.started) {
        if (Math.abs(event.clientY - drag.startY) < DRAG_THRESHOLD) return;
        drag.started = true;
        window.getSelection()?.removeAllRanges();
        document.body.classList.add("codovo-dragging-list");
        setDragFrom(drag.from);
      }
      const index = dropIndexAt(event.clientY);
      dropRef.current = index;
      setDropIndex(index);
    };
    const finish = (commit: boolean) => {
      const drag = dragRef.current;
      dragRef.current = null;
      setPending(false);
      setDragFrom(null);
      setDropIndex(null);
      document.body.classList.remove("codovo-dragging-list");
      const index = dropRef.current;
      dropRef.current = null;
      // 按下了但没挪过，那就是普通点击，什么都不用做
      if (!drag?.started || !commit || index === null) return;

      // 落点下标数的是「空档」，抽走源项后它后面的空档会左移一格
      const insertAt = index > drag.from ? index - 1 : index;
      if (insertAt === drag.from) return;
      const next = [...commandsRef.current];
      const [moved] = next.splice(drag.from, 1);
      next.splice(insertAt, 0, moved);
      onChangeRef.current(next);
      // 被拖的那条如果正展开着，跟着它落到新位置
      if (openRef.current === drag.from) onOpenRef.current(insertAt);
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  }, [pending]);

  // 从下面「系统支持」点「已添加」时卡片可能在视口外，展开后滚到它；已经在视口里就不动
  useEffect(() => {
    if (openIndex === null) return;
    const row = listRef.current?.children[openIndex] as HTMLElement | undefined;
    row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [openIndex]);

  return (
    <div ref={listRef} className="flex w-full flex-col gap-2">
      {commands.map((item, index) => {
        const dropBefore = dropIndex === index;
        const dropAfter = dropIndex === commands.length && index === commands.length - 1;
        const open = openIndex === index;
        return (
          <div
            key={index}
            className="relative overflow-hidden rounded-lg border border-line-strong bg-raised transition-colors"
          >
            {/* 落点线：插在某行之前画在它上面，插在末尾画在最后一行下面 */}
            {(dropBefore || dropAfter) && (
              <span
                className={
                  "pointer-events-none absolute right-0 left-0 z-10 h-0.5 rounded bg-accent-strong " +
                  (dropBefore ? "-top-0.5" : "-bottom-0.5")
                }
              />
            )}
            <div className="flex items-center gap-1.5 p-2.5">
              <div
                onPointerDown={onHandleDown(index)}
                title="拖动调整顺序"
                className={
                  "flex h-6 w-4 shrink-0 cursor-grab items-center justify-center text-fg-faint hover:text-fg-muted " +
                  (dragFrom === index ? "opacity-40" : "")
                }
              >
                <IconGripVertical className="h-3.5 w-3.5" />
              </div>
              <button
                type="button"
                onClick={() => onOpenChange(open ? null : index)}
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
              >
                <IconChevronDown
                  className={
                    "h-3.5 w-3.5 shrink-0 text-fg-faint transition-transform " +
                    (open ? "" : "-rotate-90")
                  }
                />
                <AgentLogo
                  name={item.name}
                  command={item.command}
                  className="h-4 w-4 shrink-0"
                />
                <span className="truncate text-[12px] text-fg">
                  {item.name.trim() || "未命名智能体"}
                </span>
                <span className="truncate font-mono text-[11px] text-fg-faint">
                  {item.command.trim() || "未填写命令"}
                </span>
              </button>
              {item.command.trim() !== "" && (
                <AgentStatusBadge
                  status={statuses[commandStatusId(item.command)]}
                  checking={checking}
                />
              )}
              <button
                type="button"
                onClick={() => {
                  onChange(commands.filter((_, i) => i !== index));
                  // 删的是展开项就收起；删在它前面则让展开项跟着左移一格
                  if (open) onOpenChange(null);
                  else if (openIndex !== null && index < openIndex) {
                    onOpenChange(openIndex - 1);
                  }
                }}
                title="删除这个智能体"
                className={LIST_ACTION}
              >
                <IconClose className="h-3 w-3" />
              </button>
            </div>

            {open && (
              <div className="flex flex-col gap-3 border-t border-line p-3">
                <Field label="名称" hint="只用于界面展示，也是终端顶栏按钮上的名字">
                  <input
                    type="text"
                    value={item.name}
                    spellCheck={false}
                    placeholder="如 Claude Code"
                    onChange={(event) =>
                      onChange(
                        commands.map((entry, i) =>
                          i === index ? { ...entry, name: event.target.value } : entry,
                        ),
                      )
                    }
                    className={TEXT_INPUT}
                  />
                </Field>
                <Field
                  label="启动命令"
                  hint="裸命令名会去 PATH 里找，也可以填完整路径；会原样在当前终端执行，工作区的其他目录由 CLI 自己支持的参数注入"
                >
                  <input
                    type="text"
                    value={item.command}
                    spellCheck={false}
                    placeholder="如 claude"
                    onChange={(event) =>
                      onChange(
                        commands.map((entry, i) =>
                          i === index ? { ...entry, command: event.target.value } : entry,
                        ),
                      )
                    }
                    className={TEXT_INPUT + " font-mono"}
                  />
                </Field>
                <Field
                  label="环境变量"
                  hint="启动时按原样注入这个 CLI 的进程环境，同名变量后写的覆盖先写的。值明文保存在本机设置里，密钥类建议交给 CLI 自己的配置或系统凭据库"
                >
                  <EnvVarEditor
                    env={item.env}
                    onChange={(env) =>
                      onChange(
                        commands.map((entry, i) => (i === index ? { ...entry, env } : entry)),
                      )
                    }
                  />
                </Field>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** 系统支持的 Agent：装了标绿、没装标红，已经配置过的可以直接展开去改 */
function SupportedAgentList({
  commands,
  statuses,
  checking,
  onAdd,
  onOpenConfigured,
}: {
  commands: AiCommand[];
  statuses: Record<string, AgentCliStatus>;
  checking: boolean;
  onAdd: (item: AgentCatalogItem) => void;
  onOpenConfigured: (index: number) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      {AGENT_CATALOG.map((item) => {
        const index = configuredIndex(item, commands);
        const status = statuses[catalogStatusId(item.key)];
        const installed = status?.installed === true;
        const missing = status !== undefined && !status.installed;
        // 支持 ACP 的这几家还能在中间区的「对话」视图里用
        const canChat = acpProviderKey(item.command) !== null;
        return (
          <div
            key={item.key}
            className={
              "flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors " +
              (installed
                ? "border-ok/30 bg-ok/[0.04] hover:border-ok/50"
                : missing
                  ? "border-danger-line bg-danger-bg/30 hover:border-danger-line"
                  : "border-line bg-raised/70 hover:border-line-hover hover:bg-raised")
            }
          >
            <div
              className={
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg " +
                (installed
                  ? "bg-ok/10 text-ok"
                  : missing
                    ? "bg-danger-bg text-danger"
                    : "bg-raised text-fg-faint")
              }
            >
              <AgentLogo name={item.name} command={item.command} className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p className="truncate text-[12px] font-medium text-fg">{item.name}</p>
                <AgentStatusBadge status={status} checking={checking} />
                {canChat && (
                  <span
                    title="可以在中间区的「对话」视图里用 ACP 接入"
                    className="shrink-0 rounded bg-active px-1.5 py-0.5 text-[10px] text-fg-dim"
                  >
                    支持对话
                  </span>
                )}
              </div>
              <p className="mt-0.5 truncate font-mono text-[10px] text-fg-faint">
                {item.command}
                {status?.version ? " · " + status.version : ""}
              </p>
              <p className="mt-0.5 truncate text-[10px] text-fg-faint" title={item.hint}>
                {missing ? "安装：" + item.install : item.hint}
              </p>
            </div>
            {index !== null ? (
              <button
                type="button"
                onClick={() => onOpenConfigured(index)}
                title="去已配置列表里编辑它"
                className={BUTTON_SM}
              >
                已添加
              </button>
            ) : (
              <button type="button" onClick={() => onAdd(item)} className={BUTTON_SM}>
                <IconPlus className="h-3 w-3" />
                添加
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function SettingsDialog({ onClose }: SettingsDialogProps) {
  const { settings, update, reset, resetSection, secretNotice } = useSettings();
  // 开发调试版可能被 src-tauri/.env 覆盖，下面在 AI 分组里如实标出来（正式版恒为空）
  const devAi = useDevAiOverrides();
  const overriddenAi = [
    devAi.baseUrl ? "接口地址" : "",
    devAi.model ? "模型" : "",
    devAi.apiKeySet ? "API 密钥" : "",
  ].filter((label) => label !== "");
  const { theme, palette, setPreference } = useTheme();
  const [tab, setTab] = useState<TabId>("appearance");
  /** 等确认的恢复默认：某个分类 id、`all` 表示整块回厂、null 表示没有 */
  const [confirmReset, setConfirmReset] = useState<TabId | "all" | null>(null);
  /** 提供商列表的手风琴：一次只展开一条 */
  const [openProvider, setOpenProvider] = useState<number | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [installMessage, setInstallMessage] = useState("");
  const [dependencyStatuses, setDependencyStatuses] = useState<Record<string, DependencyStatus>>({});
  const [checkingDependencies, setCheckingDependencies] = useState(true);
  /** 编程 Agent 的安装状态，key 见 lib/agents.ts 的 catalogStatusId / commandStatusId */
  const [agentStatuses, setAgentStatuses] = useState<Record<string, AgentCliStatus>>({});
  const [checkingAgents, setCheckingAgents] = useState(true);
  /** 已配置 Agent 的手风琴：一次只展开一条 */
  const [openAgent, setOpenAgent] = useState<number | null>(null);
  /** 检测批次的序号，用来丢掉过期结果 */
  const agentCheckRef = useRef(0);
  /** 等确认的「删除提供商」 */
  const [pendingRemove, setPendingRemove] = useState<{
    provider: AiProvider;
  } | null>(null);
  // 一次滚轮手势会连着抛好几个事件，不挡一下会一口气翻过两三个分类
  const lastFlipRef = useRef(0);
  // 到边界后攒够两下才翻页：一到底就跳走太容易误触。
  // dir 记方向，count 记已完成的独立滑动次数，last 记上一次边界事件的时刻
  const edgeRef = useRef({ dir: 0, count: 0, last: 0 });
  /** null = 还没拖过，按类名给的默认尺寸居中摆；拖过之后是具体像素 */
  const [box, setBox] = useState<DialogBox | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<ResizeDrag | null>(null);
  const moveRef = useRef<MoveDrag | null>(null);

  /** 落一条键位：与别的命令撞键就拒绝并回一句提示，否则写进设置。返回 null 表示已接受 */
  const applyShortcut = (id: string, combo: string): string | null => {
    const owner = SHORTCUT_COMMANDS.find(
      (command) => command.id !== id && settings.shortcuts[command.id] === combo,
    );
    if (owner) return `与「${owner.label}」冲突`;
    update({ shortcuts: { ...settings.shortcuts, [id]: combo } });
    return null;
  };

  // 右边栏只剩一个模块开着时，它的「隐藏」不能再点，否则右边栏就空了。
  // 顺序照 ToolRail 的注册表来，加模块时这里跟着补一行
  const rightVisible: Record<ToolId, boolean> = {
    files: settings.rightFilesVisible,
    changes: settings.rightChangesVisible,
    browser: settings.rightBrowserVisible,
    remote: settings.rightRemoteVisible,
    database: settings.rightDatabaseVisible,
    preview: settings.rightPreviewVisible,
    deploy: settings.rightDeployVisible,
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

  /**
   * 检测系统支持的 Agent 和已配置的命令是否在本机。
   *
   * 只在打开设置时和点「重新检测」时跑：每次检测都要起子进程读版本，跟着命令输入逐字
   * 触发太浪费。检测失败不挡设置面板，徽标停在「未检测」，用户可以点刷新重试。
   */
  const refreshAgents = async () => {
    // 命令改得快时可能叠起两批检测，只让最后发起的那批落地
    const generation = ++agentCheckRef.current;
    setCheckingAgents(true);
    try {
      // 同一条命令配了多次只查一次
      const configured = new Map<string, string>();
      for (const item of settings.aiCommands) {
        const command = item.command.trim();
        if (command !== "") configured.set(commandStatusId(command), command);
      }
      const statuses = await checkAgentClis([
        ...AGENT_CATALOG.map((item) => ({
          id: catalogStatusId(item.key),
          commands: [item.command, ...item.aliases],
        })),
        ...Array.from(configured, ([id, command]) => ({ id, commands: [command] })),
      ]);
      if (generation !== agentCheckRef.current) return;
      setAgentStatuses(Object.fromEntries(statuses.map((status) => [status.id, status])));
    } catch {
      // 见上：失败时保持「未检测」
    } finally {
      if (generation === agentCheckRef.current) setCheckingAgents(false);
    }
  };

  // 命令文本变了才需要重新探测：改名、改环境变量都不影响可执行文件在不在。
  // 防抖是为了不在输入命令时每敲一个字就起一批子进程；打开设置面板也会走这一趟。
  const agentCommandSignature = settings.aiCommands
    .map((item) => item.command)
    .join("\n");
  useEffect(() => {
    const timer = window.setTimeout(() => void refreshAgents(), 500);
    return () => window.clearTimeout(timer);
  }, [agentCommandSignature]);

  // ---- 模型提供商 ----

  /** 下拉里存的是 `provider/model` 引用，不是哪一项；指向失效时由 resolveDefaultModel 兜底 */
  const resolved = resolveDefaultModel(settings);
  const defaultRef = resolved?.ref ?? "";

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

  /** 删之前弹确认：模型配置会一起没，不可撤销 */
  const askRemoveProvider = (provider: AiProvider) => {
    setPendingRemove({ provider });
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

  /** 滚到两头后要再滚两下才翻分类：第一下只算「预备」，第二下才翻，避免一到底就跳走。
      按「滑动」计数而不是按事件数：触控板一次惯性会连抛很多事件，只有停手后再滑
      （与上一次边界事件的间隔超过 EDGE_GAP_MS）才算新的一下。离开边界或翻页后清零重攒；
      内容不足一屏时两头都算到底，同样两下才翻 */
  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (event.deltaY === 0) return;
    const el = event.currentTarget;
    const dir = event.deltaY > 0 ? 1 : -1;
    const atEdge =
      dir > 0
        ? el.scrollTop + el.clientHeight >= el.scrollHeight - 1
        : el.scrollTop <= 0;
    if (!atEdge) {
      edgeRef.current = { dir: 0, count: 0, last: 0 };
      return;
    }
    const now = Date.now();
    // 与上一次边界事件离得太近，视为同一次滑动（触控板惯性），只刷新时刻、不计数
    if (edgeRef.current.dir === dir && now - edgeRef.current.last <= EDGE_GAP_MS) {
      edgeRef.current.last = now;
      return;
    }
    const count = edgeRef.current.dir === dir ? edgeRef.current.count + 1 : 1;
    edgeRef.current = { dir, count, last: now };
    if (count >= 2) {
      edgeRef.current = { dir: 0, count: 0, last: 0 };
      flipTab(dir);
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

  /** 当前页的标题与说明；tab 一定在 TABS 里，兜底只是让 TS 不用非空断言 */
  const currentTab = TABS.find((item) => item.id === tab) ?? TABS[0];

  return (
    <div
      ref={overlayRef}
      className="codovo-overlay-in fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-6 backdrop-blur-[2px]"
      // 认「按下点就在遮罩上」而不是 click：从弹窗内按下、拖到遮罩上松开会误判成点外部
      onMouseDown={(event) => {
        if (event.button !== 0 || event.target !== event.currentTarget) return;
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
        className="codovo-dialog-in relative flex h-[640px] max-h-full w-[780px] max-w-full flex-col overflow-hidden rounded-2xl border border-line-strong bg-raised shadow-[0_24px_80px_-16px_rgb(0_0_0_/_0.7)]"
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
          className="flex h-14 shrink-0 cursor-move items-center border-b border-line px-5 select-none"
        >
          <div className="flex flex-1 items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent/10 text-accent ring-1 ring-accent/20">
              <IconSettings className="h-4 w-4" />
            </span>
            <span className="text-[13px] font-semibold tracking-wide text-fg">设置</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="关闭"
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg text-fg-dim transition-colors hover:bg-hover hover:text-fg"
          >
            <IconClose className="h-3.5 w-3.5" />
          </button>
        </header>

        <div className="flex min-h-0 flex-1">
          <nav className="flex w-[184px] shrink-0 flex-col gap-0.5 border-r border-line bg-panel/30 p-2.5">
            {TABS.map((item) => {
              const Icon = item.icon;
              const active = tab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-current={active ? "page" : undefined}
                  onClick={() => setTab(item.id)}
                  className={`group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[12px] transition-colors ${
                    active
                      ? "bg-selected text-fg"
                      : "text-fg-dim hover:bg-hover hover:text-fg"
                  }`}
                >
                  <Icon
                    className={`h-4 w-4 transition-colors ${
                      active ? "text-accent" : "text-fg-icon group-hover:text-fg-muted"
                    }`}
                  />
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {active && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
                </button>
              );
            })}
          </nav>

          {/* key 用 tab：切分类时容器重建，滚动位置跟着归零 */}
          <div
            key={tab}
            onWheel={onWheel}
            className="min-h-0 flex-1 overflow-auto"
          >
            <div className="codovo-tab-in flex flex-col gap-5 p-5">
              <div className="flex flex-col gap-1">
                <h2 className="text-[15px] font-semibold tracking-tight text-fg">
                  {currentTab.label}
                </h2>
                <p className="text-[11px] leading-relaxed text-fg-faint">{currentTab.desc}</p>
              </div>
              {tab === "appearance" && (
                <>
                  <Section title="主题" dense>
                    <Row label="配色方案">
                      <ThemeSelect />
                    </Row>
                  </Section>
                  <Section
                    title="字体"
                    dense
                    hint={`字体名写 CSS font-family，可写多个用逗号分隔。界面留空用默认无衬线栈；终端与编辑器留空用 ${DEFAULT_MONO_FONT}；界面等宽字体留空跟随编辑器字体`}
                  >
                    <Row label="界面字体">
                      <input
                        type="text"
                        value={settings.uiFontFamily}
                        spellCheck={false}
                        placeholder={DEFAULT_UI_FONT}
                        onChange={(event) => update({ uiFontFamily: event.target.value })}
                        className={TEXT_INPUT}
                      />
                    </Row>
                    <Row label="终端字体">
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
                    </Row>
                    <Row label="终端字号">
                      <SizeSlider
                        value={settings.terminalFontSize}
                        onChange={(terminalFontSize) => update({ terminalFontSize })}
                      />
                    </Row>
                    <Row label="终端字重">
                      <BoolToggle
                        value={settings.terminalFontBold}
                        options={WEIGHT_OPTIONS}
                        onChange={(terminalFontBold) => update({ terminalFontBold })}
                      />
                    </Row>
                    <Row label="编辑器字体">
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
                    </Row>
                    <Row label="界面等宽字体">
                      <input
                        type="text"
                        value={settings.uiMonoFontFamily}
                        spellCheck={false}
                        placeholder={resolveFont(settings.editorFontFamily)}
                        onChange={(event) =>
                          update({ uiMonoFontFamily: event.target.value })
                        }
                        className={TEXT_INPUT}
                      />
                    </Row>
                    <Row label="编辑器字号">
                      <SizeSlider
                        value={settings.editorFontSize}
                        onChange={(editorFontSize) => update({ editorFontSize })}
                      />
                    </Row>
                    <Row label="编辑器字重">
                      <BoolToggle
                        value={settings.editorFontBold}
                        options={WEIGHT_OPTIONS}
                        onChange={(editorFontBold) => update({ editorFontBold })}
                      />
                    </Row>
                  </Section>
                  <Section
                    title="界面"
                    dense
                    hint="右栏模块显隐；关掉的模块不再出现在图标条上，至少留一个。"
                  >
                    <Row label="文件">
                      <BoolToggle
                        value={settings.rightFilesVisible}
                        options={VISIBLE_OPTIONS}
                        disabledValue={lastVisible === "files" ? false : undefined}
                        onChange={(rightFilesVisible) => update({ rightFilesVisible })}
                      />
                    </Row>
                    <Row label="变更">
                      <BoolToggle
                        value={settings.rightChangesVisible}
                        options={VISIBLE_OPTIONS}
                        disabledValue={lastVisible === "changes" ? false : undefined}
                        onChange={(rightChangesVisible) => update({ rightChangesVisible })}
                      />
                    </Row>
                    <Row label="浏览器">
                      <BoolToggle
                        value={settings.rightBrowserVisible}
                        options={VISIBLE_OPTIONS}
                        disabledValue={lastVisible === "browser" ? false : undefined}
                        onChange={(rightBrowserVisible) => update({ rightBrowserVisible })}
                      />
                    </Row>
                    <Row label="远程连接">
                      <BoolToggle
                        value={settings.rightRemoteVisible}
                        options={VISIBLE_OPTIONS}
                        disabledValue={lastVisible === "remote" ? false : undefined}
                        onChange={(rightRemoteVisible) => update({ rightRemoteVisible })}
                      />
                    </Row>
                    <Row label="数据库">
                      <BoolToggle
                        value={settings.rightDatabaseVisible}
                        options={VISIBLE_OPTIONS}
                        disabledValue={lastVisible === "database" ? false : undefined}
                        onChange={(rightDatabaseVisible) => update({ rightDatabaseVisible })}
                      />
                    </Row>
                    <Row label="预览">
                      <BoolToggle
                        value={settings.rightPreviewVisible}
                        options={VISIBLE_OPTIONS}
                        disabledValue={lastVisible === "preview" ? false : undefined}
                        onChange={(rightPreviewVisible) => update({ rightPreviewVisible })}
                      />
                    </Row>
                    <Row label="部署">
                      <BoolToggle
                        value={settings.rightDeployVisible}
                        options={VISIBLE_OPTIONS}
                        disabledValue={lastVisible === "deploy" ? false : undefined}
                        onChange={(rightDeployVisible) => update({ rightDeployVisible })}
                      />
                    </Row>
                  </Section>
                  <Section title="行为" dense>
                    <Row
                      label="关闭窗口"
                      hint="开着工作区时，关闭只收起界面让它在托盘里继续跑（终端、助手不受影响）；要真退出请用托盘菜单"
                    >
                      <BoolToggle
                        value={settings.closeToTray}
                        options={CLOSE_OPTIONS}
                        onChange={(closeToTray) => update({ closeToTray })}
                      />
                    </Row>
                    <Row
                      label="启动恢复工作区"
                      hint="启动时自动打开上次的工作区；关掉则每次从空界面开始（记录留着，开回来还在）"
                    >
                      <BoolToggle
                        value={settings.restoreWorkspace}
                        options={ON_OFF_OPTIONS}
                        onChange={(restoreWorkspace) => update({ restoreWorkspace })}
                      />
                    </Row>
                  </Section>
                </>
              )}

              {tab === "terminal" && (
                <>
                  <Section title="终端" hint="只影响新建的终端；已在运行的会话保持原样">
                    <Field label="终端程序">
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
                      label="GPU 加速"
                      hint="用 WebGL 渲染终端，重输出时更省 CPU；个别显卡 / 驱动上会出现花屏（输出过程中画面花掉、得调一下布局才恢复），关掉即退回内置渲染器。只对新建的终端生效"
                    >
                      <BoolToggle
                        value={settings.terminalGpuAcceleration}
                        options={ON_OFF_OPTIONS}
                        onChange={(terminalGpuAcceleration) =>
                          update({ terminalGpuAcceleration })
                        }
                      />
                    </Field>
                    <Field
                      label="等待提示"
                      hint="终端里 AI CLI 停在需要输入的提示上、或一轮任务跑完回到空闲时，在标签和侧栏标出来；靠输出特征判断，可能误报"
                    >
                      <BoolToggle
                        value={settings.terminalWaitHint}
                        options={VISIBLE_OPTIONS}
                        onChange={(terminalWaitHint) => update({ terminalWaitHint })}
                      />
                    </Field>
                  </Section>
                </>
              )}

              {tab === "editor" && (
                <>
                  <Section title="排版">
                    <Field
                      label="缩进宽度"
                      hint="按文件内容自动探测是 Monaco 的默认行为；选了具体宽度就固定下来"
                    >
                      <Select
                        value={settings.editorIndent}
                        options={INDENT_OPTIONS}
                        onChange={(editorIndent) => update({ editorIndent })}
                      />
                    </Field>
                    <Field label="缩略图" hint="编辑器右侧的 minimap（代码缩略图）">
                      <BoolToggle
                        value={settings.editorMinimap}
                        options={ON_OFF_OPTIONS}
                        onChange={(editorMinimap) => update({ editorMinimap })}
                      />
                    </Field>
                    <Field label="自动换行" hint="长行在编辑器里自动折行；关掉后按原样横向滚动">
                      <BoolToggle
                        value={settings.editorWordWrap}
                        options={ON_OFF_OPTIONS}
                        onChange={(editorWordWrap) => update({ editorWordWrap })}
                      />
                    </Field>
                    <Field label="行号" hint="编辑器左侧的行号栏。差异视图同样跟着变">
                      <BoolToggle
                        value={settings.editorLineNumbers}
                        options={ON_OFF_OPTIONS}
                        onChange={(editorLineNumbers) => update({ editorLineNumbers })}
                      />
                    </Field>
                    <Field
                      label="当前行高亮"
                      hint="把光标所在的那一行（连同行号）标出来；关掉后编辑区更干净，但不好定位光标"
                    >
                      <BoolToggle
                        value={settings.editorHighlightActiveLine}
                        options={ON_OFF_OPTIONS}
                        onChange={(editorHighlightActiveLine) =>
                          update({ editorHighlightActiveLine })
                        }
                      />
                    </Field>
                    <Field
                      label="行高"
                      hint="存的是倍数，按「字号 × 倍数」交给 Monaco，所以改字号时行距跟着一起变；Monaco 自己的默认约为 1.35（Windows / Linux）/ 1.5（macOS）"
                    >
                      <Select
                        value={settings.editorLineHeight}
                        options={LINE_HEIGHT_OPTIONS}
                        onChange={(editorLineHeight) => update({ editorLineHeight })}
                      />
                    </Field>
                  </Section>
                  <Section title="保存">
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
                    <Field
                      label="保存时格式化"
                      hint="落盘前先用 Prettier 格式化一遍；当前文件类型不被 Prettier 支持、或格式化失败时按原内容保存"
                    >
                      <BoolToggle
                        value={settings.editorFormatOnSave}
                        options={ON_OFF_OPTIONS}
                        onChange={(editorFormatOnSave) => update({ editorFormatOnSave })}
                      />
                    </Field>
                    <Field
                      label="保存前检查语法"
                      hint="用 Prettier 的解析器解析一遍（JSON / JSONC / JSON5 / YAML / JS / TS / CSS / HTML / Markdown / GraphQL 等）。手动保存有问题会问「仍然保存 / 取消」，自动保存跳过校验以避免频繁解析"
                    >
                      <BoolToggle
                        value={settings.editorCheckSyntaxOnSave}
                        options={ON_OFF_OPTIONS}
                        onChange={(editorCheckSyntaxOnSave) =>
                          update({ editorCheckSyntaxOnSave })
                        }
                      />
                    </Field>
                  </Section>
                </>
              )}

              {tab === "shortcuts" && (
                <Section
                  title="应用命令"
                  hint="点一下控件再按下要用的组合键即可录制，Esc 取消。「关闭标签页」在编辑器、终端和右侧面板里都生效；编辑器命令（保存 / 查找 / 格式化 / 切换标签…）在编辑器区按下时生效；窗口级命令（设置 / 侧栏 / 字号）在除终端与输入框以外的任何地方生效——终端里 Ctrl+B、Ctrl+PageUp/Down 这类键有自己的含义，宿主不抢。终端里的 Ctrl+C / Ctrl+V 与 Esc 关闭弹窗保留内置，不在这里配置。"
                >
                  {SHORTCUT_COMMANDS.map((command) => (
                    <Field
                      key={command.id}
                      label={command.label}
                      hint={`默认 ${formatShortcut(command.defaultCombo)}`}
                      action={
                        <button
                          type="button"
                          disabled={settings.shortcuts[command.id] === command.defaultCombo}
                          onClick={() => applyShortcut(command.id, command.defaultCombo)}
                          className="rounded-md border border-line-strong px-2 py-0.5 text-[11px] text-fg-muted transition-colors hover:border-line-hover hover:bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-line-strong disabled:hover:bg-transparent disabled:hover:text-fg-muted"
                        >
                          恢复默认
                        </button>
                      }
                    >
                      <ShortcutRecorder
                        combo={settings.shortcuts[command.id]}
                        onRecord={(next) => applyShortcut(command.id, next)}
                      />
                    </Field>
                  ))}
                </Section>
              )}

              {tab === "dependencies" && (
                <>
                  <Section
                    title="基础运行环境"
                    hint="这些工具用于文件变更、终端和本机 AI 命令。已安装的会显示版本。"
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
                    hint="按需安装；装好后到「智能体」页配置启动命令和环境变量。"
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
                    hint="只在使用 Codovo 的 GitHub 反馈功能时需要。"
                  >
                    <DependencyRow
                      id="gh"
                      label="GitHub CLI"
                      detail="https://cli.github.com/ · 安装后运行 gh auth login"
                      installing={false}
                      checking={checkingDependencies}
                      status={dependencyStatuses.gh}
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

              {tab === "agents" && (
                <>
                  <Section
                    title="已配置"
                    hint="终端顶栏按这里的顺序摆按钮，空命令的条目不会出现；按住左侧把手可调整顺序，点条目展开改命令和环境变量"
                    action={
                      <button
                        type="button"
                        onClick={() => {
                          setOpenAgent(settings.aiCommands.length);
                          update({
                            aiCommands: [
                              ...settings.aiCommands,
                              { name: "", command: "", env: [] },
                            ],
                          });
                        }}
                        title="添加一个编程 Agent"
                        className={HEAD_ACTION}
                      >
                        <IconPlus className="h-3 w-3" />
                      </button>
                    }
                  >
                    {settings.aiCommands.length === 0 ? (
                      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-line-strong px-4 py-6 text-center">
                        <IconBot className="h-5 w-5 text-fg-faint" />
                        <p className="text-[12px] text-fg-muted">还没有配置编程 Agent</p>
                        <p className="max-w-[320px] text-[11px] leading-relaxed text-fg-faint">
                          从下面的「系统支持」里挑一个，或者点右上角的加号手动添加一条命令。
                        </p>
                      </div>
                    ) : (
                      <AgentCommandList
                        commands={settings.aiCommands}
                        statuses={agentStatuses}
                        checking={checkingAgents}
                        openIndex={openAgent}
                        onOpenChange={setOpenAgent}
                        onChange={(aiCommands) => update({ aiCommands })}
                      />
                    )}
                  </Section>

                  <Section
                    title="系统支持"
                    hint="本机是否安装按可执行文件是否在 PATH 中判断；用 npx 这类包运行器临时启动的会显示未安装，装了但读不出版本号仍按已安装算"
                    action={
                      <button
                        type="button"
                        onClick={() => void refreshAgents()}
                        disabled={checkingAgents}
                        title="重新检测本机安装情况"
                        className={HEAD_ACTION + " disabled:opacity-40"}
                      >
                        <IconRefresh
                          className={
                            checkingAgents
                              ? "h-3.5 w-3.5 animate-spin"
                              : "h-3.5 w-3.5"
                          }
                        />
                      </button>
                    }
                  >
                    <SupportedAgentList
                      commands={settings.aiCommands}
                      statuses={agentStatuses}
                      checking={checkingAgents}
                      onAdd={(item) => {
                        const next = [
                          ...settings.aiCommands,
                          { name: item.name, command: item.command, env: [] },
                        ];
                        update({ aiCommands: next });
                        setOpenAgent(next.length - 1);
                      }}
                      onOpenConfigured={setOpenAgent}
                    />
                  </Section>

                </>
              )}

              {tab === "agent" && (
                <>
                  <Section
                    title="模型提供商"
                    hint="OpenAI 兼容的服务都能接入，一家一条；应用助手和「变更」里的提交信息生成都读这里"
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
                        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-line-strong px-4 py-6 text-center">
                          <IconBot className="h-5 w-5 text-fg-faint" />
                          <p className="text-[12px] text-fg-muted">还没有提供商</p>
                          <p className="max-w-[320px] text-[11px] leading-relaxed text-fg-faint">
                            填好接口地址和至少一个模型就能用；应用助手、文档翻译和提交信息生成都读这里。
                          </p>
                          <button type="button" onClick={addProvider} className={BUTTON}>
                            <IconPlus className="h-3 w-3" />
                            添加提供商
                          </button>
                        </div>
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
                          直接注入子进程环境）。改完重开应用生效；已在跑的助手要停掉再起。
                        </p>
                      )}
                    </div>
                  </Section>

                  <Section
                    title="默认模型"
                    hint="应用助手、提交信息与部署诊断这些 AI 功能默认用它"
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
                    title="文档翻译"
                    hint="Markdown / 纯文本文档的翻译复用上面的全局默认模型，不需要单独配置接口和密钥"
                  >
                    <Field
                      label="目标语言"
                      hint="切换后翻译视图会按新语言重新翻译；也可以在翻译视图里直接切换"
                    >
                      <Select
                        value={settings.translateTarget}
                        options={TRANSLATE_TARGET_OPTIONS}
                        onChange={(next) =>
                          update({ translateTarget: next as TranslateTarget })
                        }
                      />
                    </Field>
                  </Section>

                </>
              )}
            </div>
          </div>
        </div>

        {/* 恢复默认沉在底部：本页那个跟随当前分类，全部那个整块回厂。
            左上角顺手显示版本，装完能自己核对（dev 构建额外带个标记） */}
        <footer className="flex h-14 shrink-0 items-center justify-between border-t border-line bg-panel/20 px-5">
          <span className="select-text rounded-full border border-line px-2 py-0.5 text-[10px] tracking-wide text-fg-faint">
            Codovo v{__APP_VERSION__}
            {import.meta.env.DEV ? " · dev" : ""}
          </span>
          <div className="flex items-center gap-2">
            {isResettableTab(tab) && (
              <button
                type="button"
                onClick={() => setConfirmReset(tab)}
                className={RESET_BUTTON}
              >
                恢复本页默认
              </button>
            )}
            <button
              type="button"
              onClick={() => setConfirmReset("all")}
              className={RESET_BUTTON}
            >
              恢复全部默认
            </button>
          </div>
        </footer>
      </div>

      {/* 挂在卡片外面、但仍在遮罩里：确认框的遮罩接住点击，冒到这一层时被上面的
          `confirmReset` 挡掉，不会连设置面板一起关 */}
      {pendingRemove && (
        <ConfirmDialog
          message={`删除提供商「${
            pendingRemove.provider.name || pendingRemove.provider.id
          }」？它的模型配置会一起去掉，无法撤销。`}
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
          message={
            confirmReset === "all"
              ? "恢复全部默认设置？模型提供商、密钥、编程 Agent 列表、字体、主题、快捷键和右栏模块都会回到初始值，无法撤销。"
              : isResettableTab(confirmReset)
                ? `恢复「${
                    TABS.find((item) => item.id === confirmReset)?.label
                  }」这一页的默认设置？${SECTION_RESET_HINT[confirmReset]}会回到初始值，无法撤销。`
                : ""
          }
          confirmLabel="恢复默认"
          onConfirm={() => {
            const target = confirmReset;
            if (target === "all") {
              reset();
              setPreference(DEFAULT_THEME);
            } else if (isResettableTab(target)) {
              resetSection(target);
              // 主题不在 Settings 上（在 theme.tsx），外观页要单独带一下
              if (target === "appearance") setPreference(DEFAULT_THEME);
            }
            setConfirmReset(null);
          }}
          onCancel={() => setConfirmReset(null)}
        />
      )}
    </div>
  );
}
