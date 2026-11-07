import { useId, useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog";

/** 只用到名字与「是不是目录」，文件树的 FileEntry 和文件面板的 PanelEntry 都满足 */
interface DeleteTarget {
  name: string;
  isDir: boolean;
}

interface DeleteConfirmDialogProps {
  /** 这一批要删的项；同一批里的父项与子项调用方已剪过枝 */
  items: DeleteTarget[];
  /** 这一侧有没有系统回收站。没有时只剩永久删除，不再给二选一 */
  canTrash: boolean;
  /** 入口指定的初始模式：Shift+Delete 直接落在「永久删除」上 */
  initialPermanent?: boolean;
  onConfirm: (permanent: boolean) => void;
  onCancel: () => void;
}

function DeleteOption({
  group,
  checked,
  title,
  note,
  onSelect,
}: {
  group: string;
  checked: boolean;
  title: string;
  note: string;
  onSelect: () => void;
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-2 rounded-md border px-2 py-1.5 transition-colors ${
        checked ? "border-accent-line bg-selected" : "border-line hover:bg-hover"
      }`}
    >
      <input
        type="radio"
        name={group}
        checked={checked}
        onChange={onSelect}
        className="mt-[3px] accent-accent"
      />
      <span className="min-w-0">
        <span className="block text-[12px] text-fg">{title}</span>
        <span className={`block text-[11px] ${checked ? "text-fg-muted" : "text-fg-dim"}`}>
          {note}
        </span>
      </span>
    </label>
  );
}

/**
 * 删除确认框。菜单里只留一个「删除」，进不进回收站在这里选：
 * 默认移到回收站（还能找回），想彻底删掉要自己切过去。
 *
 * 回收站不是哪一侧都有（远程面板就没有），拿不到时只给永久删除，
 * 文案也换成说死的那套。外壳沿用 ConfirmDialog，Esc / 点遮罩都算取消。
 */
export function DeleteConfirmDialog({
  items,
  canTrash,
  initialPermanent = false,
  onConfirm,
  onCancel,
}: DeleteConfirmDialogProps) {
  const permanentOnly = !canTrash;
  const [permanent, setPermanent] = useState(permanentOnly || initialPermanent);
  const group = useId();

  const head =
    items.length === 1
      ? items[0].isDir
        ? `删除文件夹「${items[0].name}」及其中全部内容？`
        : `删除文件「${items[0].name}」？`
      : `删除选中的 ${items.length} 项？`;

  return (
    <ConfirmDialog
      message={`${head}${permanent ? "此操作不可撤销。" : "会移到系统回收站，可从回收站恢复。"}`}
      confirmLabel={permanent ? "永久删除" : "移到回收站"}
      // 只有彻底删除才用危险色：进回收站还能找回，别让它看着像不可撤销
      danger={permanent}
      onConfirm={() => onConfirm(permanent)}
      onCancel={onCancel}
    >
      {!permanentOnly && (
        <div className="mt-3 space-y-1.5">
          <DeleteOption
            group={group}
            checked={!permanent}
            title="移到回收站"
            note="删错了可以从系统回收站恢复"
            onSelect={() => setPermanent(false)}
          />
          <DeleteOption
            group={group}
            checked={permanent}
            title="永久删除"
            note="不进入回收站，此操作不可撤销"
            onSelect={() => setPermanent(true)}
          />
        </div>
      )}
    </ConfirmDialog>
  );
}
