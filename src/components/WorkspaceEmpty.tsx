interface WorkspaceEmptyProps {
  error: string | null;
  onPick: () => void;
}

export function WorkspaceEmpty({ error, onPick }: WorkspaceEmptyProps) {
  return (
    <section className="flex h-full min-h-0 flex-col items-center justify-center gap-4 bg-panel px-8">
      <p className="text-[13px] text-fg-dim">还没有打开工作区</p>

      <p className="max-w-sm text-center text-[12px] leading-relaxed text-fg-faint">
        从左侧列表点击打开一个工作区，或新建一个工作区。
      </p>

      <button
        type="button"
        onClick={onPick}
        className="rounded border border-accent-line bg-raised px-4 py-1.5 text-[12px] text-accent-soft hover:bg-active"
      >
        新建工作区
      </button>

      {error && (
        <p className="max-w-sm rounded border border-danger-line bg-danger-bg px-2 py-1 text-center text-[11px] text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
