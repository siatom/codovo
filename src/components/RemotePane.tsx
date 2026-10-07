import { useCallback, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { ConfirmDialog } from "./ConfirmDialog";
import { FullscreenButton } from "./FullscreenButton";
import { RemoteFiles } from "./RemoteFiles";
import { RemoteHostDialog } from "./RemoteHostDialog";
import { RemoteTerminal } from "./RemoteTerminal";
import { useRemoteHosts } from "../lib/remote-hosts";
import { clearHostSecrets, type RemoteConnectionState, type RemoteHost } from "../lib/remote";
import { IconMore, IconPlus, IconServer } from "./icons";

const ACTIVE_KEY = "codedock.remoteActiveHost";
const TAB_KEY = "codedock.remoteTab";

type SubTab = "terminal" | "files";

function readSession(key: string): string {
  try {
    return window.sessionStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writeSession(key: string, value: string) {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // 记不住只影响下次打开时的还原，不影响使用
  }
}

const HEAD_BUTTON =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-dim hover:bg-active hover:text-fg disabled:text-fg-faint disabled:hover:bg-transparent";

const SEGMENT = "rounded px-2 py-0.5 text-[11px]";

const MENU_ITEM =
  "flex w-full items-center rounded px-2 py-1 text-left text-[12px] text-fg-muted hover:bg-hover hover:text-fg";

/** 状态点配色 */
function dotClass(state: RemoteConnectionState | undefined): string {
  switch (state?.phase) {
    case "connecting":
      return "bg-warn animate-pulse";
    case "ready":
      return "bg-accent";
    case "error":
      return "bg-danger";
    default:
      return "bg-fg-faint";
  }
}

/**
 * 右栏「远程连接」模块：左侧主机列表 + 右侧「终端 / 文件」两个子视图。
 *
 * 面板独占编辑器那一列（和浏览器模块同款），所以有地方摆「列表 + 宽内容」。
 * 已连接的主机会各自留一个终端实例（`display:none` 藏着不卸载），切走不杀——和终端、
 * 智能体一个路子。
 */
export function RemotePane({
  fullscreen,
  onToggleFullscreen,
}: {
  fullscreen: boolean;
  onToggleFullscreen: () => void;
}) {
  const { hosts, addHost, updateHost, removeHost } = useRemoteHosts();
  // 回调里要读最新的主机列表（连接成功回报指纹时），用 ref 免得闭包读到旧值
  const hostsRef = useRef(hosts);
  hostsRef.current = hosts;

  const [activeHostId, setActiveHostId] = useState<string>(() => readSession(ACTIVE_KEY));
  const [subTab, setSubTab] = useState<SubTab>(() =>
    readSession(TAB_KEY) === "files" ? "files" : "terminal",
  );
  /** 用户这次会话里主动连过的主机（点了才连，不在挂载时自动连） */
  const [connected, setConnected] = useState<string[]>([]);
  const [states, setStates] = useState<Record<string, RemoteConnectionState>>({});
  const [sessionIds, setSessionIds] = useState<Record<string, number>>({});
  /** 点「重连」或改了连接参数后 +1，靠 key 变化把 RemoteTerminal 重挂一次 */
  const [nonces, setNonces] = useState<Record<string, number>>({});
  const [dialog, setDialog] = useState<{ host: RemoteHost | null } | null>(null);
  const [menu, setMenu] = useState<{ host: RemoteHost; x: number; y: number } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<RemoteHost | null>(null);

  const activeHost = useMemo(
    () => hosts.find((host) => host.id === activeHostId) ?? null,
    [hosts, activeHostId],
  );
  const connectedHosts = useMemo(
    () => hosts.filter((host) => connected.includes(host.id)),
    [hosts, connected],
  );
  const activeSessionId = activeHost ? sessionIds[activeHost.id] : undefined;
  const activeState = activeHost ? states[activeHost.id] : undefined;

  const pickTab = useCallback((next: SubTab) => {
    setSubTab(next);
    writeSession(TAB_KEY, next);
  }, []);

  const bumpNonce = useCallback((id: string) => {
    setNonces((current) => ({ ...current, [id]: (current[id] ?? 0) + 1 }));
  }, []);

  const openHost = useCallback((host: RemoteHost) => {
    setActiveHostId(host.id);
    writeSession(ACTIVE_KEY, host.id);
    setConnected((list) => (list.includes(host.id) ? list : [...list, host.id]));
  }, []);

  const disconnectHost = useCallback((id: string) => {
    setConnected((list) => list.filter((item) => item !== id));
    setSessionIds((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    setStates((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  }, []);

  const saveHost = useCallback(
    (host: RemoteHost) => {
      const exists = hostsRef.current.some((item) => item.id === host.id);
      if (exists) updateHost(host);
      else addHost(host);
      setDialog(null);
      setActiveHostId(host.id);
      writeSession(ACTIVE_KEY, host.id);
      // 改过连接参数就重连一次，别让旧会话继续用旧配置
      if (connected.includes(host.id)) bumpNonce(host.id);
    },
    [addHost, updateHost, bumpNonce, connected],
  );

  const deleteHost = useCallback(
    (host: RemoteHost) => {
      disconnectHost(host.id);
      removeHost(host.id);
      setMenu(null);
      setActiveHostId((current) => (current === host.id ? "" : current));
      // 清钥匙串是顺带做的，失败也不该把主机留在列表里（大不了留个孤儿条目）
      void clearHostSecrets(host.id).catch(() => {});
    },
    [disconnectHost, removeHost],
  );

  const handleSession = useCallback((hostId: string, sessionId: number | null) => {
    setSessionIds((current) => {
      if (sessionId === null) {
        if (!(hostId in current)) return current;
        const next = { ...current };
        delete next[hostId];
        return next;
      }
      return { ...current, [hostId]: sessionId };
    });
  }, []);

  const handleState = useCallback((hostId: string, state: RemoteConnectionState) => {
    setStates((current) => ({ ...current, [hostId]: state }));
  }, []);

  const handleFingerprint = useCallback(
    (hostId: string, fingerprint: string) => {
      const host = hostsRef.current.find((item) => item.id === hostId);
      if (host && host.fingerprint !== fingerprint) {
        updateHost({ ...host, fingerprint });
      }
    },
    [updateHost],
  );

  /** 指纹对不上时，用户确认后清掉旧指纹并重连（TOFU 的「确认无误」这一步） */
  const trustFingerprint = useCallback(
    (host: RemoteHost) => {
      updateHost({ ...host, fingerprint: "" });
      bumpNonce(host.id);
    },
    [updateHost, bumpNonce],
  );

  const openMenu = (event: ReactMouseEvent, host: RemoteHost) => {
    event.stopPropagation();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ host, x: rect.right, y: rect.bottom + 4 });
  };

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-1 bg-panel">
      {/* 左窄栏：主机列表 */}
      <div className="flex h-full w-44 shrink-0 flex-col border-r border-line">
        <div className="flex h-8 shrink-0 items-center gap-1 border-b border-line px-2">
          <span className="min-w-0 flex-1 truncate text-[11px] font-medium tracking-wide text-fg-dim">
            远程连接
          </span>
          <button
            type="button"
            onClick={() => setDialog({ host: null })}
            title="新增主机"
            className={HEAD_BUTTON}
          >
            <IconPlus className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto py-1">
          {hosts.length === 0 ? (
            <p className="px-3 py-2 text-[11px] leading-relaxed text-fg-faint">
              还没有主机。点右上角 + 添加一台。
            </p>
          ) : (
            hosts.map((host) => {
              const state = states[host.id];
              const isActive = host.id === activeHostId;
              return (
                <div
                  key={host.id}
                  onClick={() => openHost(host)}
                  className={`group flex cursor-default items-center gap-2 rounded-md px-2 py-1 ${
                    isActive ? "bg-selected" : "hover:bg-hover"
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass(state)}`}
                    title={state?.error ?? undefined}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] text-fg">{host.name}</span>
                    <span className="block truncate text-[10px] text-fg-faint">
                      {host.user ? `${host.user}@` : ""}
                      {host.host}:{host.port}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={(event) => openMenu(event, host)}
                    title="更多"
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-faint opacity-0 hover:bg-active hover:text-fg group-hover:opacity-100"
                  >
                    <IconMore className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* 右侧：终端 / 文件 */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-2">
          <IconServer className="h-3.5 w-3.5 shrink-0 text-fg-dim" />
          <span className="min-w-0 flex-1 truncate text-[12px] text-fg">
            {activeHost ? activeHost.name : "未选择主机"}
            {activeHost && (
              <span className="ml-2 text-[11px] text-fg-faint">
                {activeHost.user ? `${activeHost.user}@` : ""}
                {activeHost.host}:{activeHost.port}
              </span>
            )}
          </span>
          <div className="flex items-center gap-0.5 rounded-md border border-line-strong p-0.5">
            <button
              type="button"
              onClick={() => pickTab("terminal")}
              className={`${SEGMENT} ${subTab === "terminal" ? "bg-selected text-fg" : "text-fg-dim hover:bg-hover"}`}
            >
              终端
            </button>
            <button
              type="button"
              onClick={() => pickTab("files")}
              className={`${SEGMENT} ${subTab === "files" ? "bg-selected text-fg" : "text-fg-dim hover:bg-hover"}`}
            >
              文件
            </button>
          </div>
          <FullscreenButton fullscreen={fullscreen} onToggle={onToggleFullscreen} />
        </header>

        {activeHost && activeState?.phase === "error" && (
          <div className="flex shrink-0 items-start gap-2 border-b border-danger-line bg-danger-bg px-2 py-1 text-[11px] text-danger">
            <span className="flex-1 break-all">{activeState.error}</span>
            {activeState.error?.includes("指纹") && (
              <button
                type="button"
                onClick={() => trustFingerprint(activeHost)}
                className="shrink-0 rounded border border-danger-line px-2 py-0.5 hover:bg-hover"
              >
                信任新指纹并重连
              </button>
            )}
          </div>
        )}

        <div className="relative min-h-0 flex-1">
          {!activeHost ? (
            <div className="absolute inset-0 flex items-center justify-center px-6">
              <p className="max-w-[320px] text-center text-[12px] leading-relaxed text-fg-faint">
                从左侧选一台主机，点一下即连接。连接后可以在这里开远程终端，或浏览、上传下载远端文件。
              </p>
            </div>
          ) : !connected.includes(activeHost.id) ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6">
              <p className="text-[12px] text-fg-faint">已选主机，尚未连接。</p>
              <button
                type="button"
                onClick={() => openHost(activeHost)}
                className="rounded-md border border-accent px-3 py-1 text-[12px] text-accent hover:bg-selected"
              >
                连接
              </button>
            </div>
          ) : (
            <>
              {connectedHosts.map((host) => (
                <RemoteTerminal
                  key={`${host.id}:${nonces[host.id] ?? 0}`}
                  host={host}
                  active={host.id === activeHostId}
                  visible={host.id === activeHostId && subTab === "terminal"}
                  onSession={handleSession}
                  onState={handleState}
                  onFingerprint={handleFingerprint}
                />
              ))}
              {activeSessionId === undefined ? (
                subTab === "files" && (
                  <div className="absolute inset-0 flex items-center justify-center px-6">
                    <p className="max-w-[320px] text-center text-[12px] leading-relaxed text-fg-faint">
                      {/* 连不上时别一直停在「正在建立连接」，否则和上面的报错自相矛盾 */}
                      {activeState?.phase === "error"
                        ? "连接失败，无法浏览远端文件。"
                        : "正在建立连接…"}
                    </p>
                  </div>
                )
              ) : (
                <div
                  className={
                    subTab === "files" ? "absolute inset-0 flex flex-col" : "hidden"
                  }
                >
                  <RemoteFiles sessionId={activeSessionId} />
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {dialog && (
        <RemoteHostDialog
          host={dialog.host}
          onSave={saveHost}
          onClose={() => setDialog(null)}
        />
      )}

      {pendingDelete && (
        <ConfirmDialog
          message={`删除主机「${pendingDelete.name}」？已保存的凭据也会一并清除。`}
          confirmLabel="删除"
          onConfirm={() => {
            deleteHost(pendingDelete);
            setPendingDelete(null);
          }}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      {menu && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setMenu(null)} />
          <div
            className="fixed z-40 w-40 rounded-lg border border-line-strong bg-raised p-1 shadow-lg"
            style={{ left: Math.max(8, menu.x - 160), top: menu.y }}
          >
            <button
              type="button"
              className={MENU_ITEM}
              onClick={() => {
                setDialog({ host: menu.host });
                setMenu(null);
              }}
            >
              编辑
            </button>
            {connected.includes(menu.host.id) && (
              <button
                type="button"
                className={MENU_ITEM}
                onClick={() => {
                  disconnectHost(menu.host.id);
                  setMenu(null);
                }}
              >
                断开连接
              </button>
            )}
            <button
              type="button"
              className={`${MENU_ITEM} text-danger hover:text-danger`}
              onClick={() => {
                setPendingDelete(menu.host);
                setMenu(null);
              }}
            >
              删除
            </button>
          </div>
        </>
      )}
    </section>
  );
}
