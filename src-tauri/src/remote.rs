//! 远程连接：SSH 交互式终端 + SFTP 文件传输。
//!
//! 几个绕不开的设计点：
//!
//! - **交互式 shell 由一个 tokio 任务独占通道**。`Channel::wait()` 要 `&mut`，而
//!   `data` / `window_change` 只要 `&self`——写和读若各起一个任务就得分半（split），
//!   但分半后拿不到 `window_change`。所以照 russh 官方交互式示例的做法：一个任务里
//!   用 `tokio::select!` 同时等「服务器来的消息」和「前端发来的写/改尺寸指令」，
//!   前端指令走一条 mpsc。
//! - **密码 / 私钥口令不回前端**。前端只存「有没有」布尔位，正文在后端按 host_id
//!   从系统钥匙串取（与 ai.rs / agent.rs 同一套口径）。
//! - **主机密钥 TOFU**（首次信任）：首次连接记下服务器指纹，之后对不上就拒绝，
//!   由用户确认后再更新。不做完整 known_hosts。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use russh::client::{self, Handle};
use russh::keys::{load_secret_key, HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::{ChannelMsg, Error as RusshError};
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileType, OpenFlags};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

/// 建连 / 认证超时。交互式会话本身不设闲置超时（`Config::inactivity_timeout = None`），
/// 但建连这一步不能无限等——网络不通时得尽快报错。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

/// 传输分块大小。分块而不是整文件 read/write：大文件不会一次性进内存，也才有进度可报。
const CHUNK: usize = 64 * 1024;

/// 远端 shell 的输出事件。输出走 base64 而非字符串：多字节 UTF-8 会被 read 从中间截断，
/// 后端一旦 decode 就产生乱码（和 pty.rs 一个道理）。
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum RemoteEvent {
    Data { data: String },
    Exit { message: String },
}

/// 传输进度。`total` 为 0 表示大小未知。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferEvent {
    pub transferred: u64,
    pub total: u64,
    pub done: bool,
}

/// SFTP 目录项。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    /// 秒级 Unix 时间戳，0 表示未知
    pub mtime: u64,
}

/// `remote_connect` 的返回：会话 id 和这次连到的服务器指纹（供前端做 TOFU 记录）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectResult {
    pub session_id: u32,
    pub fingerprint: String,
}

/// 前端发往 shell 任务的指令。
enum ShellCmd {
    Data(Vec<u8>),
    Resize { cols: u16, rows: u16 },
    Close,
}

/// `remote_connect` 的入参。参数多，打包成一个对象传，免得命令签名太长。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectRequest {
    pub host_id: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    /// "password" | "key"
    pub auth_kind: String,
    pub key_path: Option<String>,
    /// 上次记下的服务器指纹；空表示首次连接
    pub expected_fingerprint: Option<String>,
}

/// `remote_test_connection` 的入参。比 `ConnectRequest` 多两个可选明文凭据：表单里刚敲的
/// 密码 / 私钥口令还没写进钥匙串，测试时得直接用；留空才回退到钥匙串里已存的。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestRequest {
    pub host_id: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    /// "password" | "key"
    pub auth_kind: String,
    pub key_path: Option<String>,
    /// 上次记下的服务器指纹；空表示首次连接
    pub expected_fingerprint: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub passphrase: Option<String>,
}

/// `remote_test_connection` 的返回：这次连到的服务器指纹，供前端展示 / 更新 TOFU。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub fingerprint: String,
}

/// SSH 客户端回调。`connect` 会按值消费 handler，所以「本次连到的指纹」用 `Arc` 从外部带出来。
struct Client {
    /// 上次记下的指纹；空表示首次连接、直接信任
    expected: Option<String>,
    seen: Arc<Mutex<Option<String>>>,
}

impl client::Handler for Client {
    type Error = RusshError;

    async fn check_server_key(
        &mut self,
        key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let fp = fingerprint(key);
        if let Ok(mut slot) = self.seen.lock() {
            *slot = Some(fp.clone());
        }
        Ok(match &self.expected {
            None => true,
            Some(expected) => expected == &fp,
        })
    }
}

/// 服务器公钥的 SHA-256 指纹，形如 `SHA256:xxxx`。和 OpenSSH 的显示一致。
fn fingerprint(key: &PublicKeyOrCertificate) -> String {
    key.public_key().fingerprint(HashAlg::Sha256).to_string()
}

struct RemoteSession {
    /// 拿它按需再开 SFTP 通道
    handle: Handle<Client>,
    /// 往交互式 shell 发指令
    shell_tx: mpsc::UnboundedSender<ShellCmd>,
    /// SFTP 会话懒开、缓存。`SftpSession` 的方法都是 `&self`，可以 `Arc` 共享
    sftp: tokio::sync::Mutex<Option<Arc<SftpSession>>>,
}

struct Inner {
    sessions: Mutex<HashMap<u32, Arc<RemoteSession>>>,
    next_id: AtomicU32,
}

pub struct RemoteState {
    inner: Arc<Inner>,
}

impl RemoteState {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Inner {
                sessions: Mutex::new(HashMap::new()),
                next_id: AtomicU32::new(1),
            }),
        }
    }

    /// 应用退出时调用：通知每个 shell 任务收摊（发完 EOF / close 后任务自己从池里摘除）。
    pub fn kill_all(&self) {
        let sessions = match self.inner.sessions.lock() {
            Ok(s) => s,
            Err(_) => return,
        };
        for session in sessions.values() {
            let _ = session.shell_tx.send(ShellCmd::Close);
        }
    }
}

impl Default for RemoteState {
    fn default() -> Self {
        Self::new()
    }
}

/// 主机 id 要拼进钥匙串条目名，secrets.rs 那边有条目名长度与合法性约束，这里先挡一道。
fn valid_host_id(host_id: &str) -> bool {
    !host_id.is_empty()
        && host_id.len() <= 64
        && host_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// 密码 / 私钥口令在系统钥匙串里的条目名。前端拿同样的规则去 `secret_set`。
pub(crate) fn password_secret_id(host_id: &str) -> String {
    format!("remote:{host_id}:password")
}

pub(crate) fn passphrase_secret_id(host_id: &str) -> String {
    format!("remote:{host_id}:passphrase")
}

/// 把连接错误文本翻成能给用户看的话。抽成纯函数是为了能单测——
/// Windows 的 socket 错误是**本地化**的（中文系统给的是「由于目标计算机积极拒绝」），
/// 光认英文 `refused` 认不出来，所以中英 + Winsock 错误码一起认。
fn describe_connect_text(text: &str) -> String {
    let lower = text.to_lowercase();
    if lower.contains("refused") || text.contains("拒绝") || text.contains("10061") {
        return "连接被拒绝：主机不可达或端口不对".to_string();
    }
    if lower.contains("timed out")
        || lower.contains("timeout")
        || text.contains("超时")
        || text.contains("10060")
    {
        return "连接超时：检查主机地址、端口和网络".to_string();
    }
    if lower.contains("no such host")
        || lower.contains("failed to lookup")
        || text.contains("找不到")
        || text.contains("11001")
    {
        return "找不到主机：检查地址拼写".to_string();
    }
    format!("连接失败：{text}")
}

fn describe_connect_error(error: &RusshError) -> String {
    describe_connect_text(&error.to_string())
}

fn session_of(state: &RemoteState, id: u32) -> Result<Arc<RemoteSession>, String> {
    state
        .inner
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .get(&id)
        .cloned()
        .ok_or_else(|| "远程会话不存在（可能已断开）".to_string())
}

/// 拿到（必要时新建）这个会话的 SFTP 子系统。
async fn sftp_of(session: &RemoteSession) -> Result<Arc<SftpSession>, String> {
    let mut guard = session.sftp.lock().await;
    if let Some(existing) = guard.as_ref() {
        return Ok(existing.clone());
    }
    let channel = session
        .handle
        .channel_open_session()
        .await
        .map_err(|e| format!("打开 SFTP 通道失败：{e}"))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| format!("请求 sftp 子系统失败：{e}"))?;
    let sftp = SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| format!("初始化 SFTP 失败：{e}"))?;
    let arc = Arc::new(sftp);
    *guard = Some(arc.clone());
    Ok(arc)
}

fn entry_mtime(meta: &russh_sftp::client::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[tauri::command]
pub async fn remote_connect(
    state: tauri::State<'_, RemoteState>,
    on_event: Channel<RemoteEvent>,
    request: ConnectRequest,
    cols: u16,
    rows: u16,
) -> Result<ConnectResult, String> {
    let ConnectRequest {
        host_id,
        host,
        port,
        user,
        auth_kind,
        key_path,
        expected_fingerprint,
    } = request;
    if !valid_host_id(&host_id) {
        return Err("非法的主机 ID".to_string());
    }
    if host.trim().is_empty() || user.trim().is_empty() {
        return Err("主机地址和用户名都不能为空".to_string());
    }

    let expected = expected_fingerprint.filter(|s| !s.is_empty());
    let seen = Arc::new(Mutex::new(None));
    let handler = Client {
        expected: expected.clone(),
        seen: seen.clone(),
    };
    // 交互式会话不该被闲置超时踢掉，所以 inactivity_timeout 设 None
    let config = Arc::new(client::Config {
        inactivity_timeout: None,
        ..Default::default()
    });

    let connected = tokio::time::timeout(
        CONNECT_TIMEOUT,
        client::connect(config, (host.as_str(), port), handler),
    )
    .await;

    let mut handle = match connected {
        Err(_) => return Err("连接超时：检查主机地址、端口和网络".to_string()),
        Ok(Err(error)) => {
            // 指纹对不上时 russh 报的是个笼统错误，这里换成更明确的提示
            let got = seen.lock().ok().and_then(|s| s.clone());
            if let (Some(expected), Some(got)) = (expected.as_ref(), got.as_ref()) {
                if expected != got {
                    return Err(format!(
                        "服务器指纹已变化（原 {expected}，现 {got}）。确认无误后再连接。"
                    ));
                }
            }
            return Err(describe_connect_error(&error));
        }
        Ok(Ok(handle)) => handle,
    };

    // 认证。密码 / 口令正文从系统钥匙串取，不进前端。
    let auth_ok = if auth_kind == "key" {
        let path = key_path
            .filter(|p| !p.trim().is_empty())
            .ok_or("私钥认证需要指定私钥文件路径")?;
        let passphrase = crate::secrets::get(&passphrase_secret_id(&host_id))?;
        // load_secret_key 是同步阻塞（要解密），挪到阻塞线程池
        let key = tokio::task::spawn_blocking(move || load_secret_key(path, passphrase.as_deref()))
            .await
            .map_err(|e| format!("加载私钥任务失败：{e}"))?
            .map_err(|e| format!("读取私钥失败：{e}"))?;
        // best_supported_rsa_hash 是 Option<Option<HashAlg>>，外层 None 表示服务器不支持 RSA
        let hash = handle.best_supported_rsa_hash().await.ok().flatten().flatten();
        handle
            .authenticate_publickey(user.clone(), PrivateKeyWithHashAlg::new(Arc::new(key), hash))
            .await
            .map_err(|e| format!("私钥认证失败：{e}"))?
    } else {
        let password = crate::secrets::get(&password_secret_id(&host_id))?
            .ok_or("没有保存密码，请先在主机设置里填写")?;
        handle
            .authenticate_password(user.clone(), password)
            .await
            .map_err(|e| format!("密码认证失败：{e}"))?
    };

    if !auth_ok.success() {
        return Err("认证失败：用户名、密码或私钥不正确".to_string());
    }

    // 开一个带 PTY 的交互式 shell 通道
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("打开会话通道失败：{e}"))?;
    channel
        .request_pty(
            false,
            "xterm-256color",
            cols.max(1) as u32,
            rows.max(1) as u32,
            0,
            0,
            &[],
        )
        .await
        .map_err(|e| format!("请求 PTY 失败：{e}"))?;
    channel
        .request_shell(true)
        .await
        .map_err(|e| format!("启动远程 shell 失败：{e}"))?;

    let (shell_tx, mut shell_rx) = mpsc::unbounded_channel::<ShellCmd>();
    let id = state.inner.next_id.fetch_add(1, Ordering::Relaxed);

    // 一个任务独占 channel：读服务器输出 + 处理前端指令。写和读不能拆成两个任务，
    // 否则拆完就够不到 window_change 了（见模块头注释）。
    let inner = state.inner.clone();
    let event_tx = on_event.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                msg = channel.wait() => {
                    match msg {
                        Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                            let encoded = base64::engine::general_purpose::STANDARD.encode(&data);
                            if event_tx.send(RemoteEvent::Data { data: encoded }).is_err() {
                                break;
                            }
                        }
                        Some(ChannelMsg::ExitStatus { exit_status }) => {
                            let _ = event_tx.send(RemoteEvent::Exit {
                                message: format!("远程 shell 已退出（退出码 {exit_status}）"),
                            });
                            break;
                        }
                        Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                            let _ = event_tx.send(RemoteEvent::Exit {
                                message: "远程连接已关闭".to_string(),
                            });
                            break;
                        }
                        _ => {}
                    }
                }
                cmd = shell_rx.recv() => {
                    match cmd {
                        Some(ShellCmd::Data(bytes)) => {
                            let _ = channel.data_bytes(bytes).await;
                        }
                        Some(ShellCmd::Resize { cols, rows }) => {
                            let _ = channel.window_change(cols as u32, rows as u32, 0, 0).await;
                        }
                        Some(ShellCmd::Close) | None => {
                            let _ = channel.eof().await;
                            let _ = channel.close().await;
                            break;
                        }
                    }
                }
            }
        }
        // 会话结束后从池里摘除，免得 id 一直挂着
        if let Ok(mut sessions) = inner.sessions.lock() {
            sessions.remove(&id);
        }
    });

    let session = Arc::new(RemoteSession {
        handle,
        shell_tx,
        sftp: tokio::sync::Mutex::new(None),
    });
    state
        .inner
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id, session);

    let fingerprint = seen
        .lock()
        .ok()
        .and_then(|s| s.clone())
        .unwrap_or_default();

    Ok(ConnectResult {
        session_id: id,
        fingerprint,
    })
}

/// 试连一次就断开，用来在保存前验证参数。不登记会话、不写钥匙串。
///
/// 密码 / 私钥口令优先用表单里刚敲的明文，留空才回退到钥匙串里已存的（编辑主机时常见）；
/// 新建主机还没有 id，没有可回退的条目，此时按「没填就不给认证凭据」处理。
/// 主机密钥沿用既有 TOFU：传了 expected_fingerprint 就校验，对不上如实报出来。
#[tauri::command]
pub async fn remote_test_connection(request: TestRequest) -> Result<TestResult, String> {
    let TestRequest {
        host_id,
        host,
        port,
        user,
        auth_kind,
        key_path,
        expected_fingerprint,
        password,
        passphrase,
    } = request;
    if host.trim().is_empty() || user.trim().is_empty() {
        return Err("主机地址和用户名都不能为空".to_string());
    }

    // 凭据解析：表单明文优先，留空才回退钥匙串。读钥匙串是同步阻塞调用，
    // 必须放在第一个 await 之前。新建主机（id 非法 / 为空）没有可回退的条目。
    let from_store = valid_host_id(&host_id);
    let password = match password.filter(|p| !p.is_empty()) {
        Some(value) => Some(value),
        None if from_store => crate::secrets::get(&password_secret_id(&host_id))?,
        None => None,
    };
    let passphrase = match passphrase.filter(|p| !p.is_empty()) {
        Some(value) => Some(value),
        None if from_store => crate::secrets::get(&passphrase_secret_id(&host_id))?,
        None => None,
    };

    let expected = expected_fingerprint.filter(|s| !s.is_empty());
    let seen = Arc::new(Mutex::new(None));
    let handler = Client {
        expected: expected.clone(),
        seen: seen.clone(),
    };
    let config = Arc::new(client::Config {
        inactivity_timeout: None,
        ..Default::default()
    });

    let connected = tokio::time::timeout(
        CONNECT_TIMEOUT,
        client::connect(config, (host.as_str(), port), handler),
    )
    .await;

    let mut handle = match connected {
        Err(_) => return Err("连接超时：检查主机地址、端口和网络".to_string()),
        Ok(Err(error)) => {
            let got = seen.lock().ok().and_then(|s| s.clone());
            if let (Some(expected), Some(got)) = (expected.as_ref(), got.as_ref()) {
                if expected != got {
                    return Err(format!(
                        "服务器指纹已变化（原 {expected}，现 {got}）。确认无误后再连接。"
                    ));
                }
            }
            return Err(describe_connect_error(&error));
        }
        Ok(Ok(handle)) => handle,
    };

    // 认证，凭据口径与 remote_connect 一致
    let auth_ok = if auth_kind == "key" {
        let path = key_path
            .filter(|p| !p.trim().is_empty())
            .ok_or("私钥认证需要指定私钥文件路径")?;
        let key = tokio::task::spawn_blocking(move || load_secret_key(path, passphrase.as_deref()))
            .await
            .map_err(|e| format!("加载私钥任务失败：{e}"))?
            .map_err(|e| format!("读取私钥失败：{e}"))?;
        let hash = handle.best_supported_rsa_hash().await.ok().flatten().flatten();
        handle
            .authenticate_publickey(user.clone(), PrivateKeyWithHashAlg::new(Arc::new(key), hash))
            .await
            .map_err(|e| format!("私钥认证失败：{e}"))?
    } else {
        let password = password.ok_or("没有可用密码，请在对话框里填写")?;
        handle
            .authenticate_password(user.clone(), password)
            .await
            .map_err(|e| format!("密码认证失败：{e}"))?
    };

    if !auth_ok.success() {
        return Err("认证失败：用户名、密码或私钥不正确".to_string());
    }

    // 认证通过即算测试成功：主动断开，不建 shell、不登记会话
    let _ = handle
        .disconnect(russh::Disconnect::ByApplication, "", "en")
        .await;

    let fingerprint = seen
        .lock()
        .ok()
        .and_then(|s| s.clone())
        .unwrap_or_default();
    Ok(TestResult { fingerprint })
}

#[tauri::command]
pub fn remote_write(state: tauri::State<'_, RemoteState>, id: u32, data: String) -> Result<(), String> {
    let session = session_of(&state, id)?;
    session
        .shell_tx
        .send(ShellCmd::Data(data.into_bytes()))
        .map_err(|_| "远程会话已关闭".to_string())
}

#[tauri::command]
pub fn remote_resize(
    state: tauri::State<'_, RemoteState>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let session = session_of(&state, id)?;
    session
        .shell_tx
        .send(ShellCmd::Resize { cols, rows })
        .map_err(|_| "远程会话已关闭".to_string())
}

#[tauri::command]
pub fn remote_disconnect(state: tauri::State<'_, RemoteState>, id: u32) -> Result<(), String> {
    let removed = state
        .inner
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&id);
    if let Some(session) = removed {
        let _ = session.shell_tx.send(ShellCmd::Close);
    }
    Ok(())
}

#[tauri::command]
pub async fn sftp_home(state: tauri::State<'_, RemoteState>, id: u32) -> Result<String, String> {
    let session = session_of(&state, id)?;
    let sftp = sftp_of(&session).await?;
    sftp.canonicalize(".")
        .await
        .map_err(|e| format!("定位远程主目录失败：{e}"))
}

#[tauri::command]
pub async fn sftp_list(
    state: tauri::State<'_, RemoteState>,
    id: u32,
    path: String,
) -> Result<Vec<SftpEntry>, String> {
    let session = session_of(&state, id)?;
    let sftp = sftp_of(&session).await?;
    let read_dir = sftp
        .read_dir(path.clone())
        .await
        .map_err(|e| format!("读取远程目录失败：{e}"))?;

    let mut entries: Vec<SftpEntry> = read_dir
        .map(|entry| {
            let meta = entry.metadata();
            SftpEntry {
                name: entry.file_name(),
                path: entry.path(),
                is_dir: matches!(entry.file_type(), FileType::Dir),
                size: meta.len(),
                mtime: entry_mtime(&meta),
            }
        })
        .collect();

    // 目录优先，同类按名字自然排序（大小写不敏感、数字按数值）
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| crate::natural_sort::compare(&a.name, &b.name))
    });
    Ok(entries)
}

#[tauri::command]
pub async fn sftp_mkdir(
    state: tauri::State<'_, RemoteState>,
    id: u32,
    path: String,
) -> Result<(), String> {
    let session = session_of(&state, id)?;
    let sftp = sftp_of(&session).await?;
    sftp.create_dir(&path)
        .await
        .map_err(|e| format!("新建远程目录失败：{e}"))
}

#[tauri::command]
pub async fn sftp_remove(
    state: tauri::State<'_, RemoteState>,
    id: u32,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    let session = session_of(&state, id)?;
    let sftp = sftp_of(&session).await?;
    let result = if is_dir {
        sftp.remove_dir(&path).await
    } else {
        sftp.remove_file(&path).await
    };
    result.map_err(|e| format!("删除失败：{e}"))
}

#[tauri::command]
pub async fn sftp_rename(
    state: tauri::State<'_, RemoteState>,
    id: u32,
    from: String,
    to: String,
) -> Result<(), String> {
    let session = session_of(&state, id)?;
    let sftp = sftp_of(&session).await?;
    sftp.rename(&from, &to)
        .await
        .map_err(|e| format!("重命名失败：{e}"))
}

#[tauri::command]
pub async fn sftp_upload(
    state: tauri::State<'_, RemoteState>,
    id: u32,
    local_path: String,
    remote_path: String,
    on_progress: Channel<TransferEvent>,
) -> Result<(), String> {
    let session = session_of(&state, id)?;
    let sftp = sftp_of(&session).await?;

    let total = tokio::fs::metadata(&local_path)
        .await
        .map_err(|e| format!("读取本地文件失败：{e}"))?
        .len();
    let mut local = tokio::fs::File::open(&local_path)
        .await
        .map_err(|e| format!("打开本地文件失败：{e}"))?;
    let mut remote = sftp
        .open_with_flags(
            &remote_path,
            OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
        )
        .await
        .map_err(|e| format!("打开远程文件失败：{e}"))?;

    let _ = on_progress.send(TransferEvent {
        transferred: 0,
        total,
        done: false,
    });
    let mut buf = vec![0u8; CHUNK];
    let mut transferred = 0u64;
    loop {
        let n = local
            .read(&mut buf)
            .await
            .map_err(|e| format!("读取本地文件失败：{e}"))?;
        if n == 0 {
            break;
        }
        remote
            .write_all(&buf[..n])
            .await
            .map_err(|e| format!("写入远程文件失败：{e}"))?;
        transferred += n as u64;
        let _ = on_progress.send(TransferEvent {
            transferred,
            total,
            done: false,
        });
    }
    remote
        .flush()
        .await
        .map_err(|e| format!("写入远程文件失败：{e}"))?;
    let _ = remote.shutdown().await;
    let _ = on_progress.send(TransferEvent {
        transferred,
        total,
        done: true,
    });
    Ok(())
}

#[tauri::command]
pub async fn sftp_download(
    state: tauri::State<'_, RemoteState>,
    id: u32,
    remote_path: String,
    local_path: String,
    on_progress: Channel<TransferEvent>,
) -> Result<(), String> {
    let session = session_of(&state, id)?;
    let sftp = sftp_of(&session).await?;

    let total = sftp
        .metadata(&remote_path)
        .await
        .map(|meta| meta.len())
        .unwrap_or(0);
    let mut remote = sftp
        .open(&remote_path)
        .await
        .map_err(|e| format!("打开远程文件失败：{e}"))?;
    let mut local = tokio::fs::File::create(&local_path)
        .await
        .map_err(|e| format!("创建本地文件失败：{e}"))?;

    let _ = on_progress.send(TransferEvent {
        transferred: 0,
        total,
        done: false,
    });
    let mut buf = vec![0u8; CHUNK];
    let mut transferred = 0u64;
    loop {
        let n = remote
            .read(&mut buf)
            .await
            .map_err(|e| format!("读取远程文件失败：{e}"))?;
        if n == 0 {
            break;
        }
        local
            .write_all(&buf[..n])
            .await
            .map_err(|e| format!("写入本地文件失败：{e}"))?;
        transferred += n as u64;
        let _ = on_progress.send(TransferEvent {
            transferred,
            total,
            done: false,
        });
    }
    local
        .flush()
        .await
        .map_err(|e| format!("写入本地文件失败：{e}"))?;
    let _ = on_progress.send(TransferEvent {
        transferred,
        total,
        done: true,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_id_only_accepts_slugs() {
        assert!(valid_host_id("abc-123_x"));
        assert!(!valid_host_id(""));
        assert!(!valid_host_id("has space"));
        assert!(!valid_host_id("路径"));
        assert!(!valid_host_id(&"x".repeat(65)));
        assert!(valid_host_id(&"x".repeat(64)));
    }

    #[test]
    fn secret_ids_are_namespaced_per_host() {
        // 两个主机、两种凭据不能撞到同一条钥匙串记录
        assert_eq!(password_secret_id("h1"), "remote:h1:password");
        assert_eq!(passphrase_secret_id("h1"), "remote:h1:passphrase");
        assert_ne!(password_secret_id("h1"), password_secret_id("h2"));
    }

    #[test]
    fn connect_error_is_translated() {
        // 中文系统给的是本地化文本，不能只认英文
        assert!(describe_connect_text(
            "连接失败：由于目标计算机积极拒绝，无法连接。 (os error 10061)"
        )
        .contains("拒绝"));
        assert!(describe_connect_text("Connection refused (os error 10061)").contains("拒绝"));
        assert!(describe_connect_text("connect timed out").contains("超时"));
        assert!(describe_connect_text("No such host is known").contains("找不到主机"));
        // 认不出的原样带出来，别吞掉信息
        assert!(describe_connect_text("something odd").starts_with("连接失败："));
    }
}
