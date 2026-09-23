import {
  useEffect,
  useRef,
  useState,
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
  type AutoSaveMode,
} from "../lib/settings";
import {
  TERMINAL_THEME_OPTIONS,
  resolveTerminalTheme,
} from "../lib/terminal-themes";
import { useTheme, type ResolvedTheme, type Theme } from "../lib/theme";
import { IconClose, IconPlus } from "./icons";

interface SettingsDialogProps {
  onClose: () => void;
}

/** 分类靠左边的竖排 tab，内容区一次只显示一组 */
const TABS = [
  { id: "appearance", label: "外观" },
  { id: "terminal", label: "终端" },
  { id: "editor", label: "编辑器" },
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

/** 字重开关：分段按钮，和主题选择共用一套视觉，省得再给 checkbox 写样式 */
function WeightToggle({
  bold,
  onChange,
}: {
  bold: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex shrink-0 gap-0.5 rounded-lg border border-line-strong p-0.5">
      {WEIGHT_OPTIONS.map((option) => (
        <button
          key={option.label}
          type="button"
          onClick={() => onChange(option.value)}
          className={`rounded-md px-2.5 py-1 text-[12px] ${
            bold === option.value
              ? "bg-selected text-fg"
              : "text-fg-dim hover:bg-hover hover:text-fg"
          }`}
        >
          {option.label}
        </button>
      ))}
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
        <span className="shrink-0 text-[8px] leading-none text-fg-faint">▼</span>
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
        <span className="shrink-0 text-[8px] leading-none text-fg-faint">▼</span>
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

export function SettingsDialog({ onClose }: SettingsDialogProps) {
  const { settings, update } = useSettings();
  const { theme, preference, setPreference } = useTheme();
  const [tab, setTab] = useState<TabId>("appearance");
  // 一次滚轮手势会连着抛好几个事件，不挡一下会一口气翻过两三个分类
  const lastFlipRef = useRef(0);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      onClick={onClose}
    >
      {/* 尺寸写死：内容少的分类不缩、内容多就滚动，来回切 tab 面板不会跳大小。
          max-h-full 留着，窗口比面板还矮时还能压下来 */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        className="flex h-[620px] max-h-full w-[640px] max-w-full flex-col overflow-hidden rounded-xl border border-line-strong bg-raised shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex h-11 shrink-0 items-center border-b border-line px-4">
          <span className="flex-1 text-[13px] font-semibold text-fg">设置</span>
          <button
            type="button"
            onClick={onClose}
            title="关闭"
            className="flex h-7 w-7 items-center justify-center rounded-md text-fg-dim hover:bg-hover hover:text-fg"
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
              )}

              {tab === "terminal" && (
                <>
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
                    <WeightToggle
                      bold={settings.terminalFontBold}
                      onChange={(terminalFontBold) => update({ terminalFontBold })}
                    />
                  </Field>
                  <Field
                    label="AI CLI 命令"
                    hint="终端工具条上 AI CLI 按钮可选的命令；多于一个时点按钮会出下拉"
                    action={
                      <button
                        type="button"
                        onClick={() =>
                          update({ aiCommands: [...settings.aiCommands, ""] })
                        }
                        title="添加一条命令"
                        className={HEAD_ACTION}
                      >
                        <IconPlus className="h-3 w-3" />
                      </button>
                    }
                  >
                    <div className="flex w-full flex-col gap-1.5">
                      {settings.aiCommands.map((command, index) => (
                        <div key={index} className="flex items-center gap-1.5">
                          <input
                            type="text"
                            value={command}
                            spellCheck={false}
                            placeholder="例如 claude"
                            onChange={(event) =>
                              update({
                                aiCommands: settings.aiCommands.map((item, i) =>
                                  i === index ? event.target.value : item,
                                ),
                              })
                            }
                            className={TEXT_INPUT}
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
                            title="删除这条命令"
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
                    <WeightToggle
                      bold={settings.editorFontBold}
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
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
