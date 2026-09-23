import { useEffect, type ReactNode } from "react";
import {
  useSettings,
  FONT_SIZE_MIN,
  FONT_SIZE_MAX,
  DEFAULT_MONO_FONT,
} from "../lib/settings";
import { useTheme, type Theme } from "../lib/theme";
import { IconClose, IconPlus } from "./icons";

interface SettingsDialogProps {
  onClose: () => void;
}

const THEME_OPTIONS: { value: Theme; label: string }[] = [
  { value: "dark", label: "深色" },
  { value: "light", label: "浅色" },
  { value: "system", label: "跟随系统" },
];

const TEXT_INPUT =
  "w-full rounded-md border border-line-strong bg-surface px-2 py-1 text-[12px] text-fg outline-none focus:border-accent";

const LIST_ACTION =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-faint hover:bg-hover hover:text-danger";

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3.5 border-t border-line px-4 py-3.5 first:border-t-0">
      <p className="text-[11px] font-medium tracking-wide text-fg-faint">{title}</p>
      {children}
    </section>
  );
}

/** 标签在上、控件在下：字体名可能很长，横排放不下 */
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[12px] text-fg-muted">{label}</span>
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

export function SettingsDialog({ onClose }: SettingsDialogProps) {
  const { settings, update } = useSettings();
  const { preference, setPreference } = useTheme();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        className="flex max-h-full w-[440px] max-w-full flex-col overflow-hidden rounded-xl border border-line-strong bg-raised shadow-lg"
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

        <div className="min-h-0 flex-1 overflow-auto">
          <Group title="外观">
            <Field label="主题">
              <div className="flex shrink-0 gap-0.5 rounded-lg border border-line-strong p-0.5">
                {THEME_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setPreference(option.value)}
                    className={`rounded-md px-2.5 py-1 text-[12px] ${
                      preference === option.value
                        ? "bg-selected text-fg"
                        : "text-fg-dim hover:bg-hover hover:text-fg"
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </Field>
          </Group>

          <Group title="终端">
            <Field
              label="AI CLI 命令"
              hint="终端工具条上 AI CLI 按钮可选的命令；多于一个时点按钮会出下拉"
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
                <button
                  type="button"
                  onClick={() =>
                    update({ aiCommands: [...settings.aiCommands, ""] })
                  }
                  className="flex items-center gap-1 self-start rounded px-1.5 py-1 text-[12px] text-fg-dim hover:bg-hover hover:text-fg"
                >
                  <IconPlus className="h-3 w-3" />
                  添加
                </button>
              </div>
            </Field>
            <Field label="字体" hint={`CSS font-family，可写多个用逗号分隔；留空用 ${DEFAULT_MONO_FONT}`}>
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
          </Group>

          <Group title="编辑器">
            <Field label="字体" hint={`CSS font-family，可写多个用逗号分隔；留空用 ${DEFAULT_MONO_FONT}`}>
              <input
                type="text"
                value={settings.editorFontFamily}
                spellCheck={false}
                placeholder={DEFAULT_MONO_FONT}
                onChange={(event) => update({ editorFontFamily: event.target.value })}
                className={TEXT_INPUT}
              />
            </Field>
            <Field label="字号">
              <SizeSlider
                value={settings.editorFontSize}
                onChange={(editorFontSize) => update({ editorFontSize })}
              />
            </Field>
          </Group>
        </div>
      </div>
    </div>
  );
}
