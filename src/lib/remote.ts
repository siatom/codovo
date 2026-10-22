import { Channel, invoke } from "@tauri-apps/api/core";
import { secretStatus, setSecret, type SecretStatus } from "./secrets";

/** 主机认证方式：密码 / 私钥文件 */
export type RemoteAuth = "password" | "key";

export interface RemoteHost {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  auth: RemoteAuth;
  /** 私钥文件路径（auth === "key" 时有意义） */
  keyPath: string;
  /** 钥匙串里存没存密码 / 私钥口令。localStorage 只留布尔位，正文留在后端 */
  hasPassword: boolean;
  hasPassphrase: boolean;
  /** 首次信任记下的服务器指纹；空串表示还没信任过 */
  fingerprint: string;
}

export interface SftpEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  /** 秒级 Unix 时间戳，0 表示未知 */
  mtime: number;
}

/** 后端推来的远程 shell 事件，和 pty 的 PtyEvent 同构 */
export type RemoteEvent =
  | { type: "data"; data: string }
  | { type: "exit"; message: string };

export interface TransferEvent {
  transferred: number;
  total: number;
  done: boolean;
}

/** 一台主机的连接状态，供主机列表上的状态点与错误提示用 */
export interface RemoteConnectionState {
  phase: "connecting" | "ready" | "error" | "closed";
  error?: string;
}

interface ConnectResult {
  sessionId: number;
  fingerprint: string;
}

export const REMOTE_HOSTS_KEY = "codovo.remoteHosts";

/** 主机列表变更时派发的本地事件，让同一窗口里的多个面板同步（跨窗口靠 storage 事件） */
export const HOSTS_EVENT = "codovo:remote-hosts";

/**
 * 主机 id 只允许 slug：后端要把它拼进系统钥匙串的条目名（见 remote.rs 的 valid_host_id）。
 * 用时间戳 + 随机后缀，够唯一也够短。
 */
export function newHostId(): string {
  return `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function passwordSecretId(hostId: string): string {
  return `remote:${hostId}:password`;
}

export function passphraseSecretId(hostId: string): string {
  return `remote:${hostId}:passphrase`;
}

/** 把一条来路不明的记录规整成 RemoteHost；缺关键字段就丢掉 */
function asHost(raw: unknown): RemoteHost | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const id = typeof item.id === "string" ? item.id : "";
  const host = typeof item.host === "string" ? item.host : "";
  if (!id || !host) return null;
  const rawPort =
    typeof item.port === "number" && Number.isFinite(item.port) ? Math.round(item.port) : 22;
  const name = typeof item.name === "string" ? item.name.trim() : "";
  return {
    id,
    name: name || host,
    host,
    port: rawPort >= 1 && rawPort <= 65535 ? rawPort : 22,
    user: typeof item.user === "string" ? item.user : "",
    auth: item.auth === "key" ? "key" : "password",
    keyPath: typeof item.keyPath === "string" ? item.keyPath : "",
    hasPassword: item.hasPassword === true,
    hasPassphrase: item.hasPassphrase === true,
    fingerprint: typeof item.fingerprint === "string" ? item.fingerprint : "",
  };
}

export function readHosts(): RemoteHost[] {
  try {
    const raw = window.localStorage.getItem(REMOTE_HOSTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(asHost).filter((host): host is RemoteHost => host !== null);
  } catch {
    return [];
  }
}

export function saveHosts(hosts: RemoteHost[]) {
  try {
    window.localStorage.setItem(REMOTE_HOSTS_KEY, JSON.stringify(hosts));
  } catch {
    // 写不进去只影响下次启动，本次会话照常
  }
  // 同一窗口里的其它面板要立刻看到（storage 事件只在别的 document 触发）
  window.dispatchEvent(new Event(HOSTS_EVENT));
}

export interface RemoteHandle {
  id: number;
  /** 这次连到的服务器指纹，供前端做 TOFU 记录 */
  fingerprint: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  disconnect(): void;
}

/** 建连 + 认证 + 开交互式 shell。密码 / 口令由后端按 hostId 从钥匙串取，前端不碰明文 */
export async function connectRemote(options: {
  host: RemoteHost;
  cols: number;
  rows: number;
  onData: (bytes: Uint8Array) => void;
  onExit: (message: string) => void;
}): Promise<RemoteHandle> {
  const { host } = options;
  const channel = new Channel<RemoteEvent>();
  channel.onmessage = (event) => {
    if (event.type === "data") options.onData(decodeBase64(event.data));
    else options.onExit(event.message);
  };

  const result = await invoke<ConnectResult>("remote_connect", {
    onEvent: channel,
    request: {
      hostId: host.id,
      host: host.host,
      port: host.port,
      user: host.user,
      authKind: host.auth,
      keyPath: host.keyPath || null,
      expectedFingerprint: host.fingerprint || null,
    },
    cols: options.cols,
    rows: options.rows,
  });

  let alive = true;
  return {
    id: result.sessionId,
    fingerprint: result.fingerprint,
    write(data) {
      if (!alive) return;
      void invoke("remote_write", { id: result.sessionId, data }).catch(() => {});
    },
    resize(cols, rows) {
      if (!alive) return;
      void invoke("remote_resize", { id: result.sessionId, cols, rows }).catch(() => {});
    },
    disconnect() {
      if (!alive) return;
      alive = false;
      void invoke("remote_disconnect", { id: result.sessionId }).catch(() => {});
    },
  };
}

/**
 * 试连一次就断开（不登记会话、不写钥匙串），用来在保存前验证参数。
 * `password` / `passphrase` 传表单里刚敲的明文；留空则后端回退到钥匙串里已存的。
 * 成功时返回这次连到的服务器指纹，供界面展示 / 更新 TOFU。
 */
export function testRemoteConnection(request: {
  hostId: string;
  host: string;
  port: number;
  user: string;
  auth: RemoteAuth;
  keyPath: string;
  expectedFingerprint: string;
  password: string;
  passphrase: string;
}): Promise<{ fingerprint: string }> {
  return invoke<{ fingerprint: string }>("remote_test_connection", {
    request: {
      hostId: request.hostId,
      host: request.host,
      port: request.port,
      user: request.user,
      authKind: request.auth,
      keyPath: request.keyPath || null,
      expectedFingerprint: request.expectedFingerprint || null,
      password: request.password || null,
      passphrase: request.passphrase || null,
    },
  });
}

export function sftpHome(id: number): Promise<string> {
  return invoke<string>("sftp_home", { id });
}

export function sftpList(id: number, path: string): Promise<SftpEntry[]> {
  return invoke<SftpEntry[]>("sftp_list", { id, path });
}

export function sftpMkdir(id: number, path: string): Promise<void> {
  return invoke<void>("sftp_mkdir", { id, path });
}

export function sftpRemove(id: number, path: string, isDir: boolean): Promise<void> {
  return invoke<void>("sftp_remove", { id, path, isDir });
}

export function sftpRename(id: number, from: string, to: string): Promise<void> {
  return invoke<void>("sftp_rename", { id, from, to });
}

export function sftpUpload(
  id: number,
  localPath: string,
  remotePath: string,
  onProgress: (event: TransferEvent) => void,
): Promise<void> {
  const channel = new Channel<TransferEvent>();
  channel.onmessage = onProgress;
  return invoke<void>("sftp_upload", { id, localPath, remotePath, onProgress: channel });
}

export function sftpDownload(
  id: number,
  remotePath: string,
  localPath: string,
  onProgress: (event: TransferEvent) => void,
): Promise<void> {
  const channel = new Channel<TransferEvent>();
  channel.onmessage = onProgress;
  return invoke<void>("sftp_download", { id, remotePath, localPath, onProgress: channel });
}

/** 写密码 / 口令进系统钥匙串。空串按删除处理（清空输入框 = 不想留了） */
export function setHostPassword(hostId: string, password: string): Promise<void> {
  return setSecret(passwordSecretId(hostId), password);
}

export function setHostPassphrase(hostId: string, passphrase: string): Promise<void> {
  return setSecret(passphraseSecretId(hostId), passphrase);
}

/** 删主机时把它的凭据一起从钥匙串里清掉，否则条目会一直留在系统里没人认领 */
export function clearHostSecrets(hostId: string): Promise<unknown> {
  return Promise.all([setHostPassword(hostId, ""), setHostPassphrase(hostId, "")]);
}

/**
 * 查这个主机在钥匙串里到底存着哪些凭据。localStorage 里的布尔位可能过期
 * （用户可能在系统设置里把条目删了），以这边为准。
 */
export async function hostSecretPresence(
  hostId: string,
): Promise<{ hasPassword: boolean; hasPassphrase: boolean; storeError: string }> {
  const passwordId = passwordSecretId(hostId);
  const passphraseId = passphraseSecretId(hostId);
  const status: SecretStatus = await secretStatus([passwordId, passphraseId]);
  return {
    hasPassword: status.available.includes(passwordId),
    hasPassphrase: status.available.includes(passphraseId),
    storeError: status.storeError,
  };
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** 取本地路径的文件名（Windows 的 `\` 和 POSIX 的 `/` 都认） */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** 远程路径一律 POSIX 语义（SFTP 走的是 `/`） */
export function joinRemote(dir: string, name: string): string {
  if (dir.endsWith("/")) return `${dir}${name}`;
  return `${dir}/${name}`;
}

/** 父目录；已在根返回 null */
export function parentRemote(path: string): string | null {
  if (!path || path === "/") return null;
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const index = trimmed.lastIndexOf("/");
  if (index <= 0) return "/";
  return trimmed.slice(0, index);
}

/** 面包屑分段：`/home/u` -> [{"/","/"},{"home","/home"},{"u","/home/u"}] */
export function remoteCrumbs(path: string): { name: string; path: string }[] {
  const parts = path.split("/").filter(Boolean);
  const crumbs = [{ name: "/", path: "/" }];
  let acc = "";
  for (const part of parts) {
    acc += `/${part}`;
    crumbs.push({ name: part, path: acc });
  }
  return crumbs;
}

export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return "";
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`;
}

export function formatMtime(seconds: number): string {
  if (!seconds) return "";
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}
