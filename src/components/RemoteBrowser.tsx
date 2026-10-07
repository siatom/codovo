import { useCallback, useEffect, useState } from "react";
import { joinLocal, localHome } from "../lib/local-fs";
import { joinRemote, sftpDownload, sftpHome, sftpUpload } from "../lib/remote";
import type { PanelEntry } from "./FilePanel";
import { LocalFiles } from "./LocalFiles";
import { RemoteFiles } from "./RemoteFiles";
import { SplitPane } from "./SplitPane";

type Role = "local" | "remote";

interface Progress {
  role: Role;
  label: string;
  transferred: number;
  total: number;
}

/**
 * 「文件」子视图的双面板：一边本地、一边远程，中间可拖动，位置可左右交换。
 *
 * 两个面板各自管自己的数据（本地走 fs 命令、远程走 SFTP），这里只负责：
 * 记住各自的当前目录与选中项、把一侧的文件传到对侧当前目录、维护传输进度。
 * 交换位置由外层的 `swapped` 控制——按钮在 RemotePane 的标题栏里。
 */
export function RemoteBrowser({ sessionId, swapped }: { sessionId: number; swapped: boolean }) {
  const [localPath, setLocalPath] = useState<string | null>(null);
  const [remotePath, setRemotePath] = useState<string | null>(null);
  const [localSelected, setLocalSelected] = useState<PanelEntry | null>(null);
  const [remoteSelected, setRemoteSelected] = useState<PanelEntry | null>(null);
  /** 传输完成后 +1，让对应面板重新列目录 */
  const [localNonce, setLocalNonce] = useState(0);
  const [remoteNonce, setRemoteNonce] = useState(0);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [transferError, setTransferError] = useState<{ role: Role; message: string } | null>(null);

  // 本地主目录只定位一次，跟主机无关
  useEffect(() => {
    let cancelled = false;
    void localHome()
      .then((home) => {
        if (!cancelled) setLocalPath(home);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // 换主机就回到那台机器的家目录
  useEffect(() => {
    let cancelled = false;
    setRemotePath(null);
    setRemoteSelected(null);
    setProgress(null);
    setTransferError(null);
    void sftpHome(sessionId)
      .then((home) => {
        if (!cancelled) setRemotePath(home);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  /** 把 `from` 一侧选中的文件传到对侧当前目录。只传文件，目录不递归 */
  const transfer = useCallback(
    async (from: Role, entry: PanelEntry) => {
      if (entry.isDir) return;
      setTransferError(null);
      const onProgress = (event: { transferred: number; total: number; done: boolean }) => {
        setProgress(
          event.done
            ? null
            : { role: from, label: entry.name, transferred: event.transferred, total: event.total },
        );
      };
      setProgress({ role: from, label: entry.name, transferred: 0, total: entry.size });
      try {
        if (from === "local") {
          if (!remotePath) return;
          await sftpUpload(sessionId, entry.path, joinRemote(remotePath, entry.name), onProgress);
          setRemoteNonce((value) => value + 1);
        } else {
          if (!localPath) return;
          await sftpDownload(sessionId, entry.path, joinLocal(localPath, entry.name), onProgress);
          setLocalNonce((value) => value + 1);
        }
      } catch (reason) {
        setProgress(null);
        setTransferError({ role: from, message: String(reason) });
      }
    },
    [sessionId, localPath, remotePath],
  );

  const local = (
    <LocalFiles
      side={swapped ? "right" : "left"}
      path={localPath}
      refreshNonce={localNonce}
      selected={localSelected}
      progress={progress?.role === "local" ? progress : null}
      transferError={transferError?.role === "local" ? transferError.message : ""}
      onNavigate={(next) => {
        setLocalPath(next);
        setLocalSelected(null);
      }}
      onSelect={setLocalSelected}
      onTransfer={(entry) => void transfer("local", entry)}
      onDismissTransferError={() => setTransferError(null)}
    />
  );

  const remote = (
    <RemoteFiles
      sessionId={sessionId}
      side={swapped ? "left" : "right"}
      path={remotePath}
      refreshNonce={remoteNonce}
      selected={remoteSelected}
      progress={progress?.role === "remote" ? progress : null}
      transferError={transferError?.role === "remote" ? transferError.message : ""}
      onNavigate={(next) => {
        setRemotePath(next);
        setRemoteSelected(null);
      }}
      onSelect={setRemoteSelected}
      onTransfer={(entry) => void transfer("remote", entry)}
      onDismissTransferError={() => setTransferError(null)}
    />
  );

  return (
    <SplitPane initial={50} min={20} max={80} first={swapped ? remote : local} second={swapped ? local : remote} />
  );
}
