import { useCallback, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { ConfirmDialog } from "./ConfirmDialog";
import { FullscreenButton } from "./FullscreenButton";
import { RemoteBrowser } from "./RemoteBrowser";
import { RemoteHostDialog } from "./RemoteHostDialog";
import { RemoteTerminal } from "./RemoteTerminal";
import { useRemoteHosts } from "../lib/remote-hosts";
import { clearHostSecrets, type RemoteConnectionState, type RemoteHost } from "../lib/remote";
import { IconArrowsLeftRight, IconClose, IconMore, IconPlus, IconServer, IconTerminal } from "./icons";

const ACTIVE_KEY = "codovo.remoteActiveHost";
const TAB_KEY = "codovo.remoteTab";
/** 主机列表宽度（像素）与「本地/远程」左右顺序，都是窗口级偏好，存 sessionStorage */
const SWAP_KEY = "codovo.remoteSwapped";

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


/** 从「按标签 id 索引」的表里删掉一批键（关标签 / 断开主机共用）。空列表直接原样返回，
 * 免得每次都造个新对象把下游的 memo 打穿 */
function without<T>(table: Record<number, T>, keys: number[]): Record<number, T> {
  if (keys.length === 0) return table;
  const next = { ...table };
  for (const key of keys) delete next[key];
  return next;
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
  sidebarTarget,
}: {
  sidebarTarget?: HTMLElement | null;
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
  /**
   * 每台已连接主机各自一组终端标签（hostId -> 标签 id 列表）。一台主机开几个终端就是
   * 几条独立的 SSH 会话；切走的主机那组留着不动（标签 display:none 藏着不卸载，
   * SSH 会话不会断）——和终端、智能体一个路子。
   */
  const [tabsByHost, setTabsByHost] = useState<Record<string, number[]>>({});
  // 回调里要读最新的标签表（关标签时算该切到哪个），用 ref 免得闭包读到旧值
  const tabsByHostRef = useRef(tabsByHost);
  tabsByHostRef.current = tabsByHost;
  /** 每台主机当前选中的标签 */
  const [activeTabByHost, setActiveTabByHost] = useState<Record<string, number>>({});
  /** 标签 -> 它那条 SSH 会话 id（SFTP 与主机状态点用它） */
  const [sessionByTab, setSessionByTab] = useState<Record<number, number>>({});
  const [stateByTab, setStateByTab] = useState<Record<number, RemoteConnectionState>>({});
  /** 点「重连」或改了连接参数后 +1，靠 key 变化把 RemoteTerminal 重挂一次（重开 SSH 会话） */
  const [nonceByTab, setNonceByTab] = useState<Record<number, number>>({});
  const nextTabIdRef = useRef(1);
  const [dialog, setDialog] = useState<{ host: RemoteHost | null } | null>(null);
  const [menu, setMenu] = useState<{ host: RemoteHost; x: number; y: number } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<RemoteHost | null>(null);
  /** 主机列表宽度（可拖动）与「本地/远程」左右顺序 */
  const [swapped, setSwapped] = useState(() => readSession(SWAP_KEY) === "1");

  const activeHost = useMemo(
    () => hosts.find((host) => host.id === activeHostId) ?? null,
    [hosts, activeHostId],
  );
  // 有标签就算连上了（关掉最后一个标签即断开，不存在「连着但没标签」的主机）
  const connectedHosts = useMemo(
    () => hosts.filter((host) => (tabsByHost[host.id]?.length ?? 0) > 0),
    [hosts, tabsByHost],
  );
  const isConnected = useCallback(
    (hostId: string) => (tabsByHost[hostId]?.length ?? 0) > 0,
    [tabsByHost],
  );
  const activeTabs = activeHost ? (tabsByHost[activeHost.id] ?? []) : [];
  const activeTabId = activeHost ? activeTabByHost[activeHost.id] : undefined;
  // SFTP 与错误横幅都跟着「当前标签」走
  const activeSessionId = activeTabId === undefined ? undefined : sessionByTab[activeTabId];
  const activeState = activeTabId === undefined ? undefined : stateByTab[activeTabId];

  /** 主机列表上那个状态点：反映这台主机当前选中标签的连接状态 */
  const stateOfHost = (hostId: string): RemoteConnectionState | undefined => {
    const tabId = activeTabByHost[hostId];
    return tabId === undefined ? undefined : stateByTab[tabId];
  };

  const pickTab = useCallback((next: SubTab) => {
    setSubTab(next);
    writeSession(TAB_KEY, next);
  }, []);

  /** 新建一个终端标签（也是「连接这台主机」的动作）。返回它的 id */
  const addTab = useCallback((hostId: string): number => {
    const id = nextTabIdRef.current;
    nextTabIdRef.current += 1;
    setTabsByHost((current) => ({ ...current, [hostId]: [...(current[hostId] ?? []), id] }));
    setActiveTabByHost((current) => ({ ...current, [hostId]: id }));
    return id;
  }, []);

  const selectTab = useCallback((hostId: string, tabId: number) => {
    setActiveTabByHost((current) => ({ ...current, [hostId]: tabId }));
  }, []);

  /** 清掉一批标签的会话 / 状态 / 重连计数 */
  const dropTabs = useCallback((removed: number[]) => {
    setSessionByTab((current) => without(current, removed));
    setStateByTab((current) => without(current, removed));
    setNonceByTab((current) => without(current, removed));
  }, []);

  /** 改过连接参数 / 换了指纹：这台主机下每个终端都重连一次，别让旧会话继续用旧配置 */
  const reconnectHost = useCallback((hostId: string) => {
    const tabs = tabsByHostRef.current[hostId] ?? [];
    if (tabs.length === 0) return;
    setNonceByTab((current) => {
      const next = { ...current };
      for (const id of tabs) next[id] = (next[id] ?? 0) + 1;
      return next;
    });
  }, []);

  const openHost = useCallback(
    (host: RemoteHost) => {
      setActiveHostId(host.id);
      writeSession(ACTIVE_KEY, host.id);
      // 点了才连、不在挂载时自动连：选中一台还没连的主机就顺手开第一个终端
      if ((tabsByHostRef.current[host.id]?.length ?? 0) === 0) addTab(host.id);
    },
    [addTab],
  );

  /** 关一个终端标签。关掉该主机最后一个就等于断开连接 */
  const closeTab = useCallback(
    (hostId: string, tabId: number) => {
      const list = tabsByHostRef.current[hostId] ?? [];
      const index = list.indexOf(tabId);
      const rest = list.filter((item) => item !== tabId);
      setTabsByHost((current) => {
        const next = { ...current };
        if (rest.length === 0) delete next[hostId];
        else next[hostId] = rest;
        return next;
      });
      // 关的是当前标签时，焦点落到它右边那个（没有就往左退一格）
      setActiveTabByHost((current) => {
        const next = { ...current };
        if (rest.length === 0) delete next[hostId];
        else if (current[hostId] === tabId) next[hostId] = rest[Math.min(index, rest.length - 1)];
        return next;
      });
      dropTabs([tabId]);
    },
    [dropTabs],
  );

  const disconnectHost = useCallback(
    (id: string) => {
      const removed = tabsByHostRef.current[id] ?? [];
      setTabsByHost((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      setActiveTabByHost((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      dropTabs(removed);
    },
    [dropTabs],
  );

  const saveHost = useCallback(
    (host: RemoteHost) => {
      const exists = hostsRef.current.some((item) => item.id === host.id);
      if (exists) updateHost(host);
      else addHost(host);
      setDialog(null);
      setActiveHostId(host.id);
      writeSession(ACTIVE_KEY, host.id);
      // 改过连接参数就重连一次，别让旧会话继续用旧配置
      reconnectHost(host.id);
    },
    [addHost, updateHost, reconnectHost],
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

  const handleSession = useCallback((tabId: number, sessionId: number | null) => {
    setSessionByTab((current) => {
      if (sessionId === null) {
        if (!(tabId in current)) return current;
        const next = { ...current };
        delete next[tabId];
        return next;
      }
      return { ...current, [tabId]: sessionId };
    });
  }, []);

  const handleState = useCallback((tabId: number, state: RemoteConnectionState) => {
    setStateByTab((current) => ({ ...current, [tabId]: state }));
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
      reconnectHost(host.id);
    },
    [updateHost, reconnectHost],
  );

  const openMenu = (event: ReactMouseEvent, host: RemoteHost) => {
    event.stopPropagation();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ host, x: rect.right, y: rect.bottom + 4 });
  };

  const toggleSwap = useCallback(() => {
    setSwapped((current) => {
      const next = !current;
      writeSession(SWAP_KEY, next ? "1" : "0");
      return next;
    });
  }, []);

  const hostList = (
    <div className="flex h-full w-full min-w-0 flex-col">
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
              const state = stateOfHost(host.id);
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
  );

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-1 bg-content">
      {sidebarTarget !== undefined
        ? sidebarTarget
          ? createPortal(hostList, sidebarTarget)
          : null
        : hostList}

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
          {/* 文件视图下才需要：交换「本地 / 远程」两个面板的左右位置 */}
          {subTab === "files" && (
            <button
              type="button"
              onClick={toggleSwap}
              title="左右交换位置"
              className={HEAD_BUTTON}
            >
              <IconArrowsLeftRight className="h-3.5 w-3.5" />
            </button>
          )}
          <FullscreenButton fullscreen={fullscreen} onToggle={onToggleFullscreen} />
        </header>

        {/* 标签栏：这台主机开了几个终端。只终端视图下才有意义，切到文件视图整条不画。
            Ctrl/Cmd+T 新建、Ctrl/Cmd+W 关闭（键位可配置），和中间那个本地终端同一套 */}
        {activeHost && isConnected(activeHost.id) && subTab === "terminal" && (
          <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-line px-2">
            <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
              {activeTabs.map((tabId, index) => {
                const isActiveTab = tabId === activeTabId;
                return (
                  <div
                    key={tabId}
                    className={`flex shrink-0 items-center rounded ${
                      isActiveTab ? "bg-active text-fg" : "text-fg-dim hover:bg-hover"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => selectTab(activeHost.id, tabId)}
                      title={`${activeHost.user ? `${activeHost.user}@` : ""}${activeHost.host}`}
                      className="flex max-w-[140px] items-center gap-1 py-0.5 pl-2 text-[11px]"
                    >
                      <IconTerminal className="h-3 w-3" />
                      <span className="truncate">终端 {index + 1}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => closeTab(activeHost.id, tabId)}
                      title="关闭这个终端"
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-faint hover:text-danger"
                    >
                      <IconClose className="h-3 w-3" />
                    </button>
                  </div>
                );
              })}
              <button
                type="button"
                onClick={() => addTab(activeHost.id)}
                title="新建终端"
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-dim hover:bg-active hover:text-fg"
              >
                <IconPlus className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}

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
          ) : !isConnected(activeHost.id) ? (
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
              {/* 所有已连接主机的所有终端都挂着，非当前那个 display:none 藏着不卸载——
                  切走的主机、切走的标签，SSH 会话和滚动历史都留着 */}
              {connectedHosts.flatMap((host) =>
                (tabsByHost[host.id] ?? []).map((tabId) => {
                  const shown =
                    host.id === activeHostId &&
                    tabId === activeTabByHost[host.id] &&
                    subTab === "terminal";
                  return (
                    <RemoteTerminal
                      key={`${host.id}:${tabId}:${nonceByTab[tabId] ?? 0}`}
                      host={host}
                      active={shown}
                      visible={shown}
                      // 每个实例只认自己那个标签，闭包按 tabId 包一层
                      onSession={(_hostId, sessionId) => handleSession(tabId, sessionId)}
                      onState={(_hostId, state) => handleState(tabId, state)}
                      onFingerprint={handleFingerprint}
                      onRequestClose={() => closeTab(host.id, tabId)}
                      onRequestNew={() => addTab(host.id)}
                    />
                  );
                }),
              )}
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
                  <RemoteBrowser sessionId={activeSessionId} swapped={swapped} />
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
            {isConnected(menu.host.id) && (
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
