import { useCallback, useEffect, useState } from "react";
import { joinLocal, localHome, localListDir, localMkdir } from "../lib/local-fs";
import {
  joinRemote,
  sftpDownload,
  sftpHome,
  sftpList,
  sftpMkdir,
  sftpUpload,
  type TransferEvent,
} from "../lib/remote";
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

  /**
   * 把 `from` 一侧的一个条目复制到对侧的 `targetDir`。**目录会连同内容递归复制**。
   *
   * 两侧路径都按「目标侧」的路径空间拼：上传走 `joinRemote`、下载走 `joinLocal`，
   * 和原来的单文件传输一致。目标目录已存在时按合并处理（`mkdir` 失败就复用它）。
   */
  const transfer = useCallback(
    async (from: Role, entry: PanelEntry, targetDir: string) => {
      setTransferError(null);
      const onProgress = (event: TransferEvent) => {
        setProgress(
          event.done
            ? null
            : { role: from, label: entry.name, transferred: event.transferred, total: event.total },
        );
      };
      setProgress({ role: from, label: entry.name, transferred: 0, total: entry.size });

      /** 递归复制一项。`dir` 是目标侧**已经存在**的目录 */
      const copy = async (item: PanelEntry, dir: string): Promise<void> => {
        if (from === "local") {
          const target = joinRemote(dir, item.name);
          if (!item.isDir) {
            await sftpUpload(sessionId, item.path, target, onProgress);
            return;
          }
          // 目录已存在就复用它（把内容并进去），否则新建
          try {
            await sftpMkdir(sessionId, target);
          } catch {
            // 建目录失败只有在它确实不存在时才是真错误，交给下面的子项写入去报
          }
          for (const child of await localListDir(item.path)) await copy(child, target);
        } else {
          const target = joinLocal(dir, item.name);
          if (!item.isDir) {
            await sftpDownload(sessionId, item.path, target, onProgress);
            return;
          }
          try {
            await localMkdir(target);
          } catch {
            // 同上：已有目录就复用
          }
          for (const child of await sftpList(sessionId, item.path)) await copy(child, target);
        }
      };

      try {
        await copy(entry, targetDir);
        setProgress(null);
        if (from === "local") setRemoteNonce((value) => value + 1);
        else setLocalNonce((value) => value + 1);
      } catch (reason) {
        setProgress(null);
        setTransferError({ role: from, message: String(reason) });
      }
    },
    [sessionId],
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
      // 双击 / 工具栏箭头：传到对侧当前目录
      onTransfer={(entry) => remotePath && void transfer("local", entry, remotePath)}
      // 拖拽落到本面板上只可能来自远程面板（同侧已在 FilePanel 里挡掉），
      // 所以方向固定是「远程 -> 本地」
      onDropEntry={(entry, targetDir) => void transfer("remote", entry, targetDir)}
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
      onTransfer={(entry) => localPath && void transfer("remote", entry, localPath)}
      // 拖拽落到本面板上只可能来自本地面板（同侧已在 FilePanel 里挡掉），
      // 所以方向固定是「本地 -> 远程」
      onDropEntry={(entry, targetDir) => void transfer("local", entry, targetDir)}
      onDismissTransferError={() => setTransferError(null)}
    />
  );

  return (
    <SplitPane initial={50} min={20} max={80} first={swapped ? remote : local} second={swapped ? local : remote} />
  );
}
