import {
  useEffect,
  useRef,
  useState,
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
  type AutoSaveMode,
} from "../lib/settings";
import {
  isValidAgentName,
  projectLayer,
  withLayer,
} from "../lib/agent-profiles";
import {
  TERMINAL_THEME_OPTIONS,
  resolveTerminalTheme,
} from "../lib/terminal-themes";
import { useTheme, DEFAULT_THEME, type ResolvedTheme, type Theme } from "../lib/theme";
import { listShells } from "../lib/pty";
import { RIGHT_TOOLS } from "./ToolRail";
import type { ToolId } from "./ToolPane";
import { ConfirmDialog } from "./ConfirmDialog";
import { IconChevronDown, IconClose, IconPlus } from "./icons";

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
] as const;

type TabId = (typeof TABS)[number]["id"];

const THEME_OPTIONS: { value: Theme; label: string }[] = [
  { value: "dark", label: "深色" },
  { value: "light", label: "浅色" },
  { value: "system", label: "跟随系统" },
];

const WEIGHT_OPTIONS: { value: boolean; label: string }[] = [
  { value: false, label: "正常" },
  { value: true, label: "加粗" },
];

const VISIBLE_OPTIONS: { value: boolean; label: string }[] = [
  { value: true, label: "展示" },
  { value: false, label: "隐藏" },
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
                className={`px-3 py-1.5 text-left text-[12px] hover:bg-hover hover:text-fg ${
                  value === item.value ? "text-fg" : "text-fg-muted"
                }`}
              >
                {item.label}
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
  onChange,
}: {
  /** 空串表示跟随界面主题 */
  value: string;
  /** 跟随界面主题时按哪套内置配色取色 */
  fallback: ResolvedTheme;
  onChange: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = TERMINAL_THEME_OPTIONS.find((option) => option.key === value);

  const swatch = (key: string) => {
    const theme = resolveTerminalTheme(key, fallback);
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
      className={`flex items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-hover hover:text-fg ${
        value === key ? "text-fg" : "text-fg-muted"
      }`}
    >
      {swatch(key)}
      <span className="min-w-0 flex-1 truncate">{label}</span>
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
  onToggle,
  onChange,
  onRemove,
}: {
  agent: AgentProfile;
  open: boolean;
  onToggle: () => void;
  onChange: (next: AgentProfile) => void;
  onRemove: () => void;
}) {
  const patch = (part: Partial<AgentProfile>) => onChange({ ...agent, ...part });
  const invalid = agent.name.trim() !== "" && !isValidAgentName(agent.name);
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
            <input
              type="text"
              value={agent.model}
              spellCheck={false}
              placeholder="模型（留空用默认）"
              onChange={(event) => patch({ model: event.target.value })}
              className={`${TEXT_INPUT} min-w-0 flex-1 font-mono`}
            />
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
  onChange,
}: {
  layer: AgentLayer;
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

export function SettingsDialog({ onClose, cwd = null }: SettingsDialogProps) {
  const { settings, update, reset } = useSettings();
  const { theme, preference, setPreference } = useTheme();
  const [tab, setTab] = useState<TabId>("appearance");
  /** 「智能体」分类的作用域：全局层还是当前项目的层 */
  const [agentScope, setAgentScope] = useState<"global" | "project">("global");
  /** 等确认的「恢复默认」；非空时弹确认框 */
  const [confirmReset, setConfirmReset] = useState(false);
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

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // 确认框开着时 Esc 归它管（取消这一下），别顺手把整个设置面板也关了
      if (event.key === "Escape" && !confirmReset) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, confirmReset]);

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
                    <div className="flex shrink-0 gap-0.5 rounded-lg border border-line-strong p-0.5">
                      {THEME_OPTIONS.map((item) => (
                        <button
                          key={item.value}
                          type="button"
                          onClick={() => setPreference(item.value)}
                          className={`rounded-md px-2.5 py-1 text-[12px] ${
                            preference === item.value
                              ? "bg-selected text-fg"
                              : "text-fg-dim hover:bg-hover hover:text-fg"
                          }`}
                        >
                          {item.label}
                        </button>
                      ))}
                    </div>
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

              {tab === "agent" && (
                <>
                  <Section
                    title="模型接口"
                    hint="任何 OpenAI 兼容的服务都能用；「变更」的提交信息生成也用它"
                  >
                    <Field
                      label="接口地址"
                      hint="例如 https://api.deepseek.com/v1、http://localhost:11434/v1（Ollama）"
                    >
                      <input
                        type="text"
                        value={settings.aiBaseUrl}
                        spellCheck={false}
                        placeholder="https://api.openai.com/v1"
                        onChange={(event) => update({ aiBaseUrl: event.target.value })}
                        className={TEXT_INPUT}
                      />
                    </Field>
                    <Field label="模型" hint="按接口文档填，例如 gpt-4o-mini、deepseek-chat">
                      <input
                        type="text"
                        value={settings.aiModel}
                        spellCheck={false}
                        placeholder="gpt-4o-mini"
                        onChange={(event) => update({ aiModel: event.target.value })}
                        className={TEXT_INPUT}
                      />
                    </Field>
                    <Field label="API 密钥" hint="只存在本机，不写进任何配置文件">
                      <input
                        type="password"
                        value={settings.aiApiKey}
                        spellCheck={false}
                        placeholder="sk-…"
                        onChange={(event) => update({ aiApiKey: event.target.value })}
                        className={TEXT_INPUT}
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
                      onChange={(next) => update(withLayer(settings, agentScope, cwd, next))}
                    />
                  </Section>
                </>
              )}
            </div>
          </div>
        </div>

        {/* 恢复默认沉在底部：它管的是所有分类，放某个 tab 里会让人以为只重置那一页 */}
        <footer className="flex h-12 shrink-0 items-center justify-end border-t border-line px-4">
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
      {confirmReset && (
        <ConfirmDialog
          message="恢复默认设置？接口地址、密钥、AI CLI 列表、字体、主题和右栏模块都会回到初始值，无法撤销。"
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
