import { useCallback, useEffect, useState } from "react";
import {
  joinRemote,
  parentRemote,
  remoteCrumbs,
  sftpList,
  sftpMkdir,
  sftpRemove,
  sftpRename,
} from "../lib/remote";
import { FilePanel, type PanelEntry, type PanelProgress } from "./FilePanel";
import { IconServer } from "./icons";

interface RemoteFilesProps {
  sessionId: number;
  /** 面板在左还是右（决定传输箭头方向） */
  side: "left" | "right";
  /** 当前目录；null 表示还没定位到远程主目录 */
  path: string | null;
  /** 容器传输完成后 +1，让对侧重新列目录 */
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
 * 远程文件面板（SFTP）的数据容器。界面交给 `FilePanel`，这里只管数据与操作。
 * 目录导航由容器受控（双面板要拿当前目录当传输目标）。
 */
export function RemoteFiles({
  sessionId,
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
}: RemoteFilesProps) {
  const [entries, setEntries] = useState<PanelEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    if (!path) {
      setEntries([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void sftpList(sessionId, path)
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
  }, [sessionId, path, refreshNonce, reloadNonce]);

  const reload = useCallback(() => setReloadNonce((value) => value + 1), []);

  const mkdir = useCallback(
    async (name: string) => {
      if (!path) return;
      await sftpMkdir(sessionId, joinRemote(path, name));
      reload();
    },
    [sessionId, path, reload],
  );

  const rename = useCallback(
    async (entry: PanelEntry, name: string) => {
      const parent = parentRemote(entry.path) ?? "/";
      await sftpRename(sessionId, entry.path, joinRemote(parent, name));
      reload();
    },
    [sessionId, reload],
  );

  const remove = useCallback(
    async (entry: PanelEntry) => {
      await sftpRemove(sessionId, entry.path, entry.isDir);
      reload();
    },
    [sessionId, reload],
  );

  const up = path ? parentRemote(path) : null;

  return (
    <FilePanel
      label="远程"
      icon={<IconServer className="h-3.5 w-3.5" />}
      side={side}
      path={path}
      crumbs={path ? remoteCrumbs(path) : []}
      entries={entries}
      selected={selected}
      loading={loading}
      error={error || transferError}
      progress={progress}
      canUp={up !== null}
      onUp={() => up && onNavigate(up)}
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
