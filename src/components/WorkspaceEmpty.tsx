interface WorkspaceEmptyProps {
  error: string | null;
  onPick: () => void;
}

export function WorkspaceEmpty({ error, onPick }: WorkspaceEmptyProps) {
  return (
    <section className="flex h-full min-h-0 flex-col items-center justify-center gap-4 bg-panel px-8">
      <p className="text-[13px] text-fg-dim">还没有打开工作目录</p>

      <button
        type="button"
        onClick={onPick}
        className="rounded border border-accent-line bg-raised px-4 py-1.5 text-[12px] text-accent-soft hover:bg-active"
      >
        选择工作目录
      </button>

      <p className="max-w-sm text-center text-[11px] leading-relaxed text-fg-faint">
        选好目录后右侧会列出文件，左侧终端也会切到该目录。
        <br />
        下次启动会自动打开它。
      </p>

      {error && (
        <p className="max-w-sm rounded border border-danger-line bg-danger-bg px-2 py-1 text-center text-[11px] text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
