import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useSettings } from "../lib/settings";
import {
  checkAppUpdate,
  hideAppUpdate,
  installAppUpdate,
  updateSize,
  useAppUpdate,
} from "../lib/updater";
import { ConfirmDialog } from "./ConfirmDialog";

const ACTION =
  "rounded border border-line-strong px-2 py-1 text-[12px] text-fg-muted hover:bg-hover disabled:opacity-50";
const LAST_CHECK = "codovo.updateLastCheck";

export function AppUpdateSettings() {
  const { settings, update } = useSettings();
  const state = useAppUpdate();
  return (
    <div className="space-y-3 text-[12px] text-fg-muted">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={settings.updateAutoCheck}
          onChange={(event) =>
            update({ updateAutoCheck: event.target.checked })
          }
        />
        自动检查更新
      </label>
      <label className="flex items-center gap-2">
        检查间隔
        <select
          className="rounded border border-line-strong bg-surface px-2 py-1"
          value={settings.updateIntervalHours}
          onChange={(event) =>
            update({ updateIntervalHours: Number(event.target.value) })
          }
        >
          {[1, 6, 12, 24].map((hours) => (
            <option key={hours} value={hours}>
              {hours} 小时
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className={ACTION}
        disabled={state.checking || state.busy}
        onClick={() => void checkAppUpdate(true)}
      >
        {state.checking ? "正在检查…" : "检查更新"}
      </button>
      {settings.updateSkippedVersion && (
        <p className="text-fg-faint">
          已跳过 v{settings.updateSkippedVersion}，手动检查仍会显示此版本。
        </p>
      )}
      {state.message && <p role="status">{state.message}</p>}
    </div>
  );
}

export function AppUpdateNotice() {
  const { settings, update } = useSettings();
  const state = useAppUpdate();
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    if (!settings.updateAutoCheck || import.meta.env.DEV) return;
    const check = () => {
      const interval = settings.updateIntervalHours * 3600000;
      const last = Number(localStorage.getItem(LAST_CHECK)) || 0;
      if (Date.now() - last < interval && last <= Date.now()) return;
      localStorage.setItem(LAST_CHECK, String(Date.now()));
      void checkAppUpdate();
    };
    // 启动时让主界面先完成挂载；后台检查不会拦住工作区恢复。
    const startup = window.setTimeout(check, 5000);
    const timer = window.setInterval(check, 60000);
    return () => {
      window.clearTimeout(startup);
      window.clearInterval(timer);
    };
  }, [settings.updateAutoCheck, settings.updateIntervalHours]);

  const release = state.update;
  if (
    !release ||
    (!state.busy &&
      !state.forceShow &&
      release.version === settings.updateSkippedVersion)
  )
    return null;
  const progress = state.progress;
  const percent = progress?.total
    ? Math.min(100, Math.floor((progress.downloaded / progress.total) * 100))
    : null;
  return createPortal(
    <div className="relative z-[60]">
      <aside
        aria-label="软件更新"
        className="fixed right-4 bottom-4 z-40 w-96 max-w-[calc(100vw-2rem)] space-y-2 rounded-xl border border-line-strong bg-raised p-4 text-[12px] text-fg shadow-lg"
      >
        <p className="font-semibold">Codovo v{release.version} 可用</p>
        <p className="text-fg-faint">{updateSize(release.size)}</p>
        {release.notes && (
          <p className="max-h-32 overflow-auto whitespace-pre-wrap break-words text-fg-muted">
            {release.notes}
          </p>
        )}
        {!release.canInstall && (
          <p className="text-fg-faint">
            当前安装方式或此版本暂不支持应用内安装，请从发布页升级。
          </p>
        )}
        {progress && (
          <div role="status" className="space-y-1">
            <p>
              {progress.phase === "installing"
                ? "正在安装并重启…"
                : `正在下载 ${updateSize(progress.downloaded)}${percent === null ? "" : `（${percent}%）`}`}
            </p>
            <progress
              className="w-full accent-accent"
              max={100}
              {...(percent === null ? {} : { value: percent })}
            />
          </div>
        )}
        {state.message && (
          <p role="status" className="text-danger">
            {state.message}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {release.canInstall && (
            <button
              type="button"
              className={ACTION}
              disabled={state.busy || state.checking}
              onClick={() => setConfirm(true)}
            >
              下载并安装
            </button>
          )}
          <button
            type="button"
            className={ACTION}
            disabled={state.busy}
            onClick={() => void openUrl(release.releaseUrl).catch(() => {})}
          >
            打开发布页
          </button>
          <button
            type="button"
            className={ACTION}
            disabled={state.busy}
            onClick={() => {
              update({ updateSkippedVersion: release.version });
              hideAppUpdate();
            }}
          >
            跳过此版本
          </button>
        </div>
      </aside>
      {confirm && (
        <ConfirmDialog
          message={`安装 v${release.version} 后将重启 Codovo，并结束正在运行的终端与任务。请先保存文件。`}
          confirmLabel="下载、安装并重启"
          onCancel={() => setConfirm(false)}
          onConfirm={() => {
            setConfirm(false);
            void installAppUpdate();
          }}
        />
      )}
    </div>,
    document.body,
  );
}
