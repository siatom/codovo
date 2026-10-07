import { useCallback, useEffect, useState } from "react";
import {
  joinLocal,
  localCrumbs,
  localListDir,
  localMkdir,
  localRemove,
  localRename,
  parentLocal,
} from "../lib/local-fs";
import { FilePanel, type PanelEntry, type PanelProgress } from "./FilePanel";
import { IconDeviceDesktop } from "./icons";

interface LocalFilesProps {
  /** 面板在左还是右（决定传输箭头方向） */
  side: "left" | "right";
  /** 当前目录；null 表示还没定位到主目录，空串表示「此电脑」（盘符列表） */
  path: string | null;
  /** 容器传输完成后 +1，重新列目录 */
  refreshNonce: number;
  selected: PanelEntry | null;
  progress: PanelProgress | null;
  /** 传输失败的原因（容器给发起方传），和内部加载错误一起显示 */
  transferError: string;
  onNavigate: (path: string) => void;
  onSelect: (entry: PanelEntry) => void;
  onTransfer: (entry: PanelEntry) => void;
  onDismissTransferError: () => void;
}

/**
 * 本地文件面板的数据容器。数据来自 `local_fs` 的命令（不受工作区白名单限制），
 * 界面复用 `FilePanel`。主目录起步，可以一直向上退到「此电脑」。
 */
export function LocalFiles({
  side,
  path,
  refreshNonce,
  selected,
  progress,
  transferError,
  onNavigate,
  onSelect,
  onTransfer,
  onDismissTransferError,
}: LocalFilesProps) {
  const [entries, setEntries] = useState<PanelEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    if (path === null) {
      setEntries([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void localListDir(path)
      .then((list) => {
        if (cancelled) return;
        setEntries(list);
        setError("");
      })
      .catch((reason) => {
        if (!cancelled) setError(String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, refreshNonce, reloadNonce]);

  const reload = useCallback(() => setReloadNonce((value) => value + 1), []);

  const mkdir = useCallback(
    async (name: string) => {
      // 「此电脑」那层没有真正的目录可落脚
      if (!path) throw new Error("请先进入一个磁盘或目录");
      await localMkdir(joinLocal(path, name));
      reload();
    },
    [path, reload],
  );

  const rename = useCallback(
    async (entry: PanelEntry, name: string) => {
      await localRename(entry.path, name);
      reload();
    },
    [reload],
  );

  const remove = useCallback(
    async (entry: PanelEntry) => {
      await localRemove(entry.path);
      reload();
    },
    [reload],
  );

  const up = path !== null ? parentLocal(path) : null;

  return (
    <FilePanel
      label="本地"
      icon={<IconDeviceDesktop className="h-3.5 w-3.5" />}
      side={side}
      path={path}
      crumbs={path !== null ? localCrumbs(path) : []}
      entries={entries}
      selected={selected}
      loading={loading}
      error={error || transferError}
      progress={progress}
      canUp={up !== null}
      onUp={() => up !== null && onNavigate(up)}
      onNavigate={onNavigate}
      onSelect={onSelect}
      onActivate={(entry) => (entry.isDir ? onNavigate(entry.path) : onTransfer(entry))}
      onRefresh={reload}
      onMkdir={mkdir}
      onRename={rename}
      onDelete={remove}
      onTransfer={onTransfer}
      onDismissError={() => {
        setError("");
        onDismissTransferError();
      }}
    />
  );
}
