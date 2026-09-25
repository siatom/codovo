//! 智能体后端：把开源的 opencode 当 headless 服务跑起来，供终端区的「智能体」tab 用。
//!
//! 为什么不让前端直接连 opencode：它监听在 localhost 的动态端口上，不会给 WebView 回
//! CORS 头，直连必被拦；而且密钥和网络调用留在 Rust 侧，和 `ai.rs` 的既定做法一致。
//!
//! 进程模型：一个工作区一个 opencode 进程，cwd 就是工作区根。懒启动（用户第一次切到
//! 智能体 tab 才起），换工作区或退出应用时杀掉。

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::fs_api::FsState;

/// SSE 事件推给前端用的事件名。全局只有一个 agent 服务，固定名就够，
/// 不像 PTY 那样每个会话一个 Channel。
pub const EVENT_NAME: &str = "agent-event";
/// 子进程自己退出（崩溃、被杀）时推的事件，前端据此提示重启。
pub const EXIT_EVENT: &str = "agent-exit";

/// 健康检查的等待上限。opencode 冷启动要装插件，慢机器上可能要十几秒。
const HEALTH_TIMEOUT: Duration = Duration::from_secs(20);
/// 管理类 HTTP 请求的超时。发消息走 prompt_async（立刻返回 204），不受这个影响。
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
/// SSE 断线后的重连间隔。
const RECONNECT_DELAY: Duration = Duration::from_secs(1);
/// 子进程退出的轮询间隔。
const EXIT_POLL: Duration = Duration::from_secs(1);
/// 报错时回传的响应体上限，别把整页 HTML 塞给用户。
const MAX_ERROR_CHARS: usize = 500;
/// 注入给 opencode 的密钥环境变量名。密钥不写进配置文件，只走环境变量。
const API_KEY_ENV: &str = "CODEDOCK_AI_API_KEY";
/// CodeDock 注册给 opencode 的 provider id，配置和发消息时的 model 都要对上。
const PROVIDER_ID: &str = "codedock";

/// 前端传进来的配置。三个接口字段复用「设置 → AI」里已有的那份。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    /// opencode 可执行文件；裸命令名会去 PATH 里找
    command: String,
    /// 固定端口；0 表示自动挑一个空闲的
    port: u16,
    base_url: String,
    model: String,
    api_key: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    port: u16,
    version: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    running: bool,
    port: Option<u16>,
}

struct Running {
    child: Child,
    port: u16,
    /// 启动时的工作区根。和当前工作区对不上就说明该重启了。
    cwd: PathBuf,
    config_dir: PathBuf,
    /// 每次启动 +1。SSE 任务和退出轮询靠它判断自己是不是已经过期。
    generation: u64,
}

pub struct AgentState {
    inner: Arc<Mutex<Option<Running>>>,
    generation: Arc<AtomicU64>,
}

impl AgentState {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(None)),
            generation: Arc::new(AtomicU64::new(1)),
        }
    }

    /// 应用退出时调用，别留下游离的 opencode 进程。
    pub fn kill(&self) {
        let mut guard = match self.inner.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        self.generation.fetch_add(1, Ordering::SeqCst);
        if let Some(mut running) = guard.take() {
            kill_child(&mut running.child);
            let _ = std::fs::remove_dir_all(&running.config_dir);
        }
    }
}

// ---- 进程解析：跨三端最容易踩空的一块 ----

/// 怎么把 opencode 真正拉起来。
pub(crate) enum Launch {
    /// 直接执行
    Direct(PathBuf),
    /// Windows 上 npm 装出来的是 .cmd 垫片，CreateProcess 不认，得借 cmd 起
    ViaCmd(PathBuf),
}

/// 把配置里的「opencode」解析成一个能 spawn 的目标。
///
/// 收的是**单个可执行文件名或路径**，不是整条命令行：`npx opencode` 那种
/// 得先拆开（cli_sessions 的 `split_command` 就是干这个的）。
pub(crate) fn resolve_launch(configured: &str, path: Option<&OsStr>) -> Result<Launch, String> {
    let trimmed = configured.trim();
    if trimmed.is_empty() {
        return Err("没有配置 opencode 可执行文件".to_string());
    }

    let found = if trimmed.contains('/') || trimmed.contains('\\') {
        let path = PathBuf::from(trimmed);
        if !path.is_file() {
            return Err(format!("找不到 opencode 可执行文件：{trimmed}"));
        }
        path
    } else {
        find_on_path(trimmed, path).ok_or_else(|| {
            format!("在 PATH 里找不到 {trimmed}，请先安装，或在「设置 → AI」里填写完整路径")
        })?
    };

    Ok(if needs_cmd_wrapper(&found) {
        Launch::ViaCmd(found)
    } else {
        Launch::Direct(found)
    })
}

/// Windows 上找可执行文件得挨个试后缀：npm 全局装出来的只有 `.cmd` 和无扩展名的
/// shell 脚本，没有 `.exe`，而 `CreateProcess` 只会自动补 `.exe`。
///
/// cli_sessions 列 opencode 会话时也要起同一个 CLI，所以放开到 crate 内——
/// 这套三端差异复制的第二遍必然漂（`hide_console` 已经在 git.rs 有一份了）。
pub(crate) fn find_on_path(name: &str, path: Option<&OsStr>) -> Option<PathBuf> {
    #[cfg(windows)]
    let names: Vec<String> = if Path::new(name).extension().is_some() {
        vec![name.to_string()]
    } else {
        vec![
            format!("{name}.exe"),
            format!("{name}.cmd"),
            format!("{name}.bat"),
        ]
    };
    #[cfg(not(windows))]
    let names: Vec<String> = vec![name.to_string()];

    std::env::split_paths(path?)
        .flat_map(|dir| names.iter().map(move |n| dir.join(n)))
        .find(|candidate| candidate.is_file())
}

#[cfg(windows)]
pub(crate) fn needs_cmd_wrapper(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some("cmd") | Some("bat")
    )
}

#[cfg(not(windows))]
pub(crate) fn needs_cmd_wrapper(_path: &Path) -> bool {
    false
}

/// 挑一个空闲端口：让系统分配，拿到号之后立刻放掉。中间那一小段窗口理论上会被
/// 别人抢，但本地开发场景不值得为此再加一层握手。
fn free_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| format!("分配端口失败: {e}"))?;
    listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|e| format!("读取端口失败: {e}"))
}

/// 用户指定了固定端口时先探一下，被占了要早点报错，别等健康检查超时。
fn check_port(port: u16) -> Result<u16, String> {
    match std::net::TcpListener::bind(("127.0.0.1", port)) {
        Ok(listener) => {
            drop(listener);
            Ok(port)
        }
        Err(_) => Err(format!(
            "端口 {port} 已被占用，请改成自动分配或换一个端口"
        )),
    }
}

// ---- 配置注入 ----

/// 生成 CodeDock 专用的 opencode 配置，写在自己的配置目录里。
///
/// 用 `OPENCODE_CONFIG_DIR` 把它指过去，完全不碰用户的 `~/.config/opencode/`；
/// 也不往工作区写 `opencode.json`——那会污染用户仓库、出现在 git 改动列表里。
fn write_config(dir: &Path, base_url: &str, model: &str) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("创建配置目录失败: {e}"))?;

    // 模型名是用户填的，得当动态 key 用，所以走 Map 而不是 json! 的字面量语法
    let mut models = serde_json::Map::new();
    models.insert(model.to_string(), serde_json::json!({ "name": model }));

    let config = serde_json::json!({
        "provider": {
            PROVIDER_ID: {
                "npm": "@ai-sdk/openai-compatible",
                "name": "CodeDock",
                "options": {
                    "baseURL": base_url,
                    // 密钥不落盘：这里只留占位符，spawn 时用环境变量注入
                    "apiKey": format!("{{env:{API_KEY_ENV}}}"),
                },
                "models": models,
            }
        },
        "model": format!("{PROVIDER_ID}/{model}"),
        // v1 没有审批 UI，不放行的话 doom_loop / external_directory 这类默认 ask 的
        // 规则会让会话卡在那儿等人点确认。这是有意的取舍，等审批 UI 做出来再收紧。
        "permission": "allow",
    });

    let text = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("opencode.json"), text).map_err(|e| format!("写入配置失败: {e}"))
}

// ---- 起进程 / 杀进程 ----

fn spawn_opencode(
    command: &str,
    port: u16,
    cwd: &Path,
    config_dir: &Path,
    api_key: &str,
) -> Result<Child, String> {
    let port_text = port.to_string();
    let args = ["serve", "--port", port_text.as_str(), "--hostname", "127.0.0.1"];
    let path = crate::shell_env::resolved_path(
        &crate::shell_env::default_shell(),
        Some(cwd),
    );

    let mut cmd = match resolve_launch(command, path.as_deref())? {
        Launch::Direct(path) => {
            let mut c = Command::new(path);
            c.args(args);
            c
        }
        Launch::ViaCmd(path) => wrap_with_cmd(&path, &args),
    };

    if let Some(path) = path {
        cmd.env("PATH", path);
    }
    cmd.current_dir(cwd)
        .env("OPENCODE_CONFIG_DIR", config_dir)
        .env(API_KEY_ENV, api_key)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    hide_console(&mut cmd);

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // 自成进程组，退出时能整组一起收
        cmd.process_group(0);
    }

    cmd.spawn().map_err(|e| {
        format!("启动 opencode 失败: {e}。请确认已安装，或在「设置 → AI」里填写完整路径")
    })
}

/// 借 cmd 起 `.cmd`/`.bat` 垫片。
///
/// `/S` 让 cmd 只剥掉最外层一对引号、其余原样，这样路径带空格也不会被拆散。
/// 参数是拼成字符串交给 cmd 的，所以**只对不含空格和引号的参数安全**——
/// 这条路径上的参数要么是端口这种数字，要么是 `session list --format json`
/// 这种固定词，都不需要转义。
#[cfg(windows)]
pub(crate) fn wrap_with_cmd(path: &Path, args: &[&str]) -> Command {
    use std::os::windows::process::CommandExt;
    let mut command = Command::new("cmd");
    command.raw_arg(format!(
        "/S /C \"\"{}\" {}\"",
        path.display(),
        args.join(" ")
    ));
    command
}

/// 非 Windows 上走不到（`needs_cmd_wrapper` 恒为 false），但得有实现才能编译过
#[cfg(not(windows))]
pub(crate) fn wrap_with_cmd(path: &Path, args: &[&str]) -> Command {
    let mut command = Command::new(path);
    command.args(args);
    command
}

/// Windows 上不隐藏的话，每次起服务都会闪一个控制台黑框
#[cfg(windows)]
pub(crate) fn hide_console(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
pub(crate) fn hide_console(_command: &mut Command) {}

#[cfg(windows)]
fn kill_child(child: &mut Child) {
    // opencode 跑 bash 工具时会派生子 shell，child.kill() 只杀得掉直接子进程，
    // 所以走 taskkill /T 连整棵树一起收
    let pid = child.id().to_string();
    let _ = Command::new("taskkill")
        .args(["/PID", &pid, "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let _ = child.wait();
}

#[cfg(not(windows))]
fn kill_child(child: &mut Child) {
    // 启动时 process_group(0) 已让它自成一组，负号表示整组一起发信号
    let pid = child.id();
    let _ = Command::new("kill")
        .args(["-s", "TERM", "--", &format!("-{pid}")])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let _ = child.kill();
    let _ = child.wait();
}

// ---- HTTP 辅助 ----

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|e| format!("无法创建 HTTP 客户端: {e}"))
}

fn truncate(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    text.chars().take(max_chars).collect()
}

/// 取当前运行实例的端口。锁在函数内就释放，不跨 await。
fn current_port(state: &AgentState) -> Result<u16, String> {
    let guard = state.inner.lock().map_err(|e| e.to_string())?;
    guard
        .as_ref()
        .map(|running| running.port)
        .ok_or_else(|| "智能体服务还没启动".to_string())
}

/// 发一个请求并把响应体当 JSON 取回来。
///
/// 不定义严格的响应结构体：opencode 的字段还在演进，换版本少一层就可能反序列化失败，
/// 用 `Value` 逐层取更耐操（和 `ai.rs` 一个路子）。
async fn request_json(
    client: &reqwest::Client,
    method: reqwest::Method,
    url: String,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let mut request = client.request(method, &url);
    if let Some(payload) = body {
        request = request.json(&payload);
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("请求 opencode 失败: {e}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!("读取 opencode 响应失败: {e}"))?;

    if !status.is_success() {
        return Err(format!(
            "opencode 返回 {}: {}",
            status.as_u16(),
            truncate(&text, MAX_ERROR_CHARS)
        ));
    }

    if text.trim().is_empty() {
        return Ok(serde_json::Value::Null);
    }

    serde_json::from_str(&text)
        .map_err(|_| format!("无法解析 opencode 响应: {}", truncate(&text, MAX_ERROR_CHARS)))
}

/// 轮询健康接口直到就绪。返回版本号。
async fn wait_healthy(port: u16, timeout: Duration) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|e| format!("无法创建 HTTP 客户端: {e}"))?;
    let url = format!("http://127.0.0.1:{port}/global/health");

    let deadline = Instant::now() + timeout;
    let mut last = "连接失败".to_string();
    while Instant::now() < deadline {
        match client.get(&url).send().await {
            Ok(response) if response.status().is_success() => {
                if let Ok(value) = response.json::<serde_json::Value>().await {
                    return Ok(value
                        .get("version")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string());
                }
            }
            Ok(response) => last = format!("HTTP {}", response.status().as_u16()),
            Err(e) => last = e.to_string(),
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }

    Err(format!("opencode 启动超时（{last}）"))
}

// ---- SSE ----

/// 从缓冲区头部切出一个完整的 SSE 帧（以空行分隔），没切到就返回 None。
///
/// 只按字节找 `\n`，切点一定落在 ASCII 边界上，不会把多字节字符劈开。
fn pop_frame(buffer: &mut String) -> Option<String> {
    let bytes = buffer.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\n' {
            // 空行才算分隔：`\n\n` 或 `\n\r\n`
            let rest = &bytes[i + 1..];
            let skip = if rest.first() == Some(&b'\n') {
                1
            } else if rest.starts_with(b"\r\n") {
                2
            } else {
                0
            };
            if skip > 0 {
                let mut frame = buffer[..i].to_string();
                // CRLF 时行尾的 \r 是分隔符的一部分，不是内容
                if frame.ends_with('\r') {
                    frame.pop();
                }
                buffer.drain(..i + 1 + skip);
                return Some(frame);
            }
        }
        i += 1;
    }
    None
}

/// 从一帧里取出 `data:` 行的内容。
///
/// opencode 的 SSE 只发 `data:` 行、不发 `event:` 行，事件类型在 JSON 的 `type` 字段里，
/// 所以这里只需要认 data。多行 data 按 SSE 规范本该用换行拼接，实测它只发单行。
fn frame_data(frame: &str) -> Option<&str> {
    frame
        .lines()
        .find_map(|line| line.strip_prefix("data:").map(str::trim_start))
}

/// 起一个后台任务持续读 SSE 并转推给前端。断了就退避重连，直到这一代实例被换掉。
fn spawn_sse(app: AppHandle, inner: Arc<Mutex<Option<Running>>>, port: u16, generation: u64) {
    tauri::async_runtime::spawn(async move {
        let client = match reqwest::Client::builder().build() {
            Ok(c) => c,
            Err(_) => return,
        };
        let url = format!("http://127.0.0.1:{port}/event");

        while is_current(&inner, generation) {
            if let Ok(mut response) = client.get(&url).send().await {
                let mut buffer = String::new();
                loop {
                    match response.chunk().await {
                        Ok(Some(chunk)) => {
                            buffer.push_str(&String::from_utf8_lossy(&chunk));
                            while let Some(frame) = pop_frame(&mut buffer) {
                                let Some(data) = frame_data(&frame) else { continue };
                                if let Ok(value) = serde_json::from_str::<serde_json::Value>(data)
                                {
                                    let _ = app.emit(EVENT_NAME, value);
                                }
                            }
                        }
                        // 流结束或出错都退到外层重连
                        Ok(None) => break,
                        Err(_) => break,
                    }
                }
            }

            if !is_current(&inner, generation) {
                break;
            }
            tokio::time::sleep(RECONNECT_DELAY).await;
        }
    });
}

/// 起一个线程盯着子进程，自己退出时清掉状态并通知前端。
///
/// 用 try_wait 轮询而不是 child.wait()：child 锁在状态里，没法 move 出去单独 wait。
fn spawn_exit_watcher(
    app: AppHandle,
    inner: Arc<Mutex<Option<Running>>>,
    generation: Arc<AtomicU64>,
    port: u16,
) {
    std::thread::spawn(move || loop {
        std::thread::sleep(EXIT_POLL);

        let mut guard = match inner.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        let alive = match guard.as_mut() {
            Some(running) if running.port == port => match running.child.try_wait() {
                Ok(Some(status)) => Some(status.code().unwrap_or(-1)),
                Ok(None) => None,
                Err(_) => Some(-1),
            },
            // 已经被换掉或停掉了，收工
            _ => return,
        };

        if let Some(code) = alive {
            guard.take();
            generation.fetch_add(1, Ordering::SeqCst);
            drop(guard);
            let _ = app.emit(EXIT_EVENT, code);
            return;
        }
    });
}

/// 这一代实例是否还是当前实例。
fn is_current(inner: &Arc<Mutex<Option<Running>>>, generation: u64) -> bool {
    match inner.lock() {
        Ok(guard) => guard
            .as_ref()
            .map(|running| running.generation == generation)
            .unwrap_or(false),
        Err(_) => false,
    }
}

// ---- 命令 ----

/// 启动智能体服务。幂等：同一个工作区已经在跑就直接返回现有信息。
#[tauri::command]
pub async fn agent_start(
    app: AppHandle,
    state: tauri::State<'_, AgentState>,
    fs_state: tauri::State<'_, FsState>,
    config: AgentConfig,
) -> Result<AgentInfo, String> {
    let base_url = config.base_url.trim().trim_end_matches('/').to_string();
    let api_key = config.api_key.trim().to_string();
    let model = config.model.trim().to_string();
    if base_url.is_empty() || api_key.is_empty() || model.is_empty() {
        return Err("请先在「设置 → AI」里填写接口地址、模型和密钥".to_string());
    }

    // git / 文件系统都是同步阻塞的，赶在第一个 await 之前跑完，别让 std 的锁跨越 await
    let cwd = fs_state.root()?;

    let (port, generation) = {
        let mut guard = state.inner.lock().map_err(|e| e.to_string())?;

        // 同一个工作区已经在跑：直接复用，不重启
        if let Some(running) = guard.as_ref() {
            if running.cwd == cwd {
                return Ok(AgentInfo {
                    port: running.port,
                    version: String::new(),
                });
            }
        }

        // 工作区变了（或之前跑挂了），先收掉旧的
        state.generation.fetch_add(1, Ordering::SeqCst);
        if let Some(mut old) = guard.take() {
            kill_child(&mut old.child);
            let _ = std::fs::remove_dir_all(&old.config_dir);
        }

        let port = if config.port == 0 {
            free_port()?
        } else {
            check_port(config.port)?
        };

        let config_dir = app
            .path()
            .app_config_dir()
            .map_err(|e| format!("拿不到配置目录: {e}"))?
            .join("opencode");
        write_config(&config_dir, &base_url, &model)?;

        let child = spawn_opencode(&config.command, port, &cwd, &config_dir, &api_key)?;
        let generation = state.generation.load(Ordering::SeqCst);

        *guard = Some(Running {
            child,
            port,
            cwd,
            config_dir,
            generation,
        });

        (port, generation)
    };

    // 健康检查是异步的，放在锁外面
    let version = match wait_healthy(port, HEALTH_TIMEOUT).await {
        Ok(version) => version,
        Err(reason) => {
            state.kill();
            return Err(reason);
        }
    };

    spawn_sse(app.clone(), state.inner.clone(), port, generation);
    spawn_exit_watcher(
        app,
        state.inner.clone(),
        state.generation.clone(),
        port,
    );

    Ok(AgentInfo { port, version })
}

#[tauri::command]
pub fn agent_status(state: tauri::State<'_, AgentState>) -> AgentStatus {
    let port = state
        .inner
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|running| running.port));
    AgentStatus {
        running: port.is_some(),
        port,
    }
}

/// 停掉服务。换工作区和退出应用时都要调。
#[tauri::command]
pub fn agent_stop(state: tauri::State<'_, AgentState>) {
    state.kill();
}

#[tauri::command]
pub async fn agent_create_session(
    state: tauri::State<'_, AgentState>,
    title: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = current_port(&state)?;
    let client = http_client()?;

    let mut body = serde_json::Map::new();
    if let Some(title) = title.filter(|t| !t.trim().is_empty()) {
        body.insert("title".to_string(), serde_json::Value::String(title));
    }

    request_json(
        &client,
        reqwest::Method::POST,
        format!("http://127.0.0.1:{port}/session"),
        Some(serde_json::Value::Object(body)),
    )
    .await
}

#[tauri::command]
pub async fn agent_messages(
    state: tauri::State<'_, AgentState>,
    session_id: String,
) -> Result<serde_json::Value, String> {
    let port = current_port(&state)?;
    let client = http_client()?;
    request_json(
        &client,
        reqwest::Method::GET,
        format!("http://127.0.0.1:{port}/session/{session_id}/message"),
        None,
    )
    .await
}

/// 列出所有会话。opencode 那边是全局存的、跨项目混在一起，调用方自己按 directory 过滤。
#[tauri::command]
pub async fn agent_list_sessions(
    state: tauri::State<'_, AgentState>,
) -> Result<serde_json::Value, String> {
    let port = current_port(&state)?;
    let client = http_client()?;
    request_json(
        &client,
        reqwest::Method::GET,
        format!("http://127.0.0.1:{port}/session"),
        None,
    )
    .await
}

/// 发一条消息。走 prompt_async：它立刻返回 204，正文靠 SSE 推回来。
#[tauri::command]
pub async fn agent_send(
    state: tauri::State<'_, AgentState>,
    session_id: String,
    text: String,
    model: Option<String>,
) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("消息不能为空".to_string());
    }

    let port = current_port(&state)?;
    let client = http_client()?;

    let mut body = serde_json::json!({
        "parts": [{ "type": "text", "text": text }],
    });

    // 显式指定模型：不指定的话会落到用户全局配置里的默认模型
    // （本机实测会落到没跑起来的 ollama，然后一路重试到超时）
    if let Some(model) = model.filter(|m| !m.trim().is_empty()) {
        if let Some(object) = body.as_object_mut() {
            object.insert(
                "model".to_string(),
                serde_json::json!({ "providerID": PROVIDER_ID, "modelID": model }),
            );
        }
    }

    request_json(
        &client,
        reqwest::Method::POST,
        format!("http://127.0.0.1:{port}/session/{session_id}/prompt_async"),
        Some(body),
    )
    .await
    .map(|_| ())
}

#[tauri::command]
pub async fn agent_abort(
    state: tauri::State<'_, AgentState>,
    session_id: String,
) -> Result<(), String> {
    let port = current_port(&state)?;
    let client = http_client()?;
    request_json(
        &client,
        reqwest::Method::POST,
        format!("http://127.0.0.1:{port}/session/{session_id}/abort"),
        None,
    )
    .await
    .map(|_| ())
}

/// 删掉一个会话（连同它的消息）。opencode 那边不可撤销，调用方要先确认。
#[tauri::command]
pub async fn agent_delete_session(
    state: tauri::State<'_, AgentState>,
    session_id: String,
) -> Result<(), String> {
    let port = current_port(&state)?;
    let client = http_client()?;
    request_json(
        &client,
        reqwest::Method::DELETE,
        format!("http://127.0.0.1:{port}/session/{session_id}"),
        None,
    )
    .await
    .map(|_| ())
}

/// 改会话标题。opencode 那边是 `PATCH /session/:id`，只动 title，不动消息。
#[tauri::command]
pub async fn agent_rename_session(
    state: tauri::State<'_, AgentState>,
    session_id: String,
    title: String,
) -> Result<(), String> {
    if title.trim().is_empty() {
        return Err("会话标题不能为空".to_string());
    }

    let port = current_port(&state)?;
    let client = http_client()?;
    request_json(
        &client,
        reqwest::Method::PATCH,
        format!("http://127.0.0.1:{port}/session/{session_id}"),
        Some(serde_json::json!({ "title": title })),
    )
    .await
    .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_splits_on_blank_line() {
        let mut buffer = String::from("data: {\"a\":1}\n\ndata: {\"b\":2}\n\n");
        assert_eq!(pop_frame(&mut buffer).as_deref(), Some("data: {\"a\":1}"));
        assert_eq!(pop_frame(&mut buffer).as_deref(), Some("data: {\"b\":2}"));
        assert_eq!(pop_frame(&mut buffer), None);
    }

    #[test]
    fn frame_keeps_partial_data_buffered() {
        // 半截帧不能吐出来，否则 JSON 解析必失败
        let mut buffer = String::from("data: {\"a\"");
        assert_eq!(pop_frame(&mut buffer), None);
        buffer.push_str(":1}\n\n");
        assert_eq!(pop_frame(&mut buffer).as_deref(), Some("data: {\"a\":1}"));
    }

    #[test]
    fn frame_accepts_crlf_separator() {
        let mut buffer = String::from("data: {\"a\":1}\r\n\r\n");
        assert_eq!(pop_frame(&mut buffer).as_deref(), Some("data: {\"a\":1}"));
    }

    #[test]
    fn frame_reads_data_line_only() {
        // opencode 不发 event: 行，但真有的话也得跳过
        assert_eq!(frame_data("data: {\"x\":1}"), Some("{\"x\":1}"));
        assert_eq!(frame_data("event: ping\ndata: 1"), Some("1"));
        assert_eq!(frame_data(": keep-alive"), None);
    }

    #[test]
    fn config_uses_dynamic_model_key() {
        let dir = std::env::temp_dir().join("codedock-agent-test-config");
        let _ = std::fs::remove_dir_all(&dir);
        write_config(&dir, "https://api.example.com/v1", "some-model").unwrap();

        let text = std::fs::read_to_string(dir.join("opencode.json")).unwrap();
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();

        // 模型名要原样成为 key，不能被 json! 当成字面量 "model"
        assert!(value["provider"]["codedock"]["models"]["some-model"].is_object());
        assert_eq!(value["model"], "codedock/some-model");
        assert_eq!(
            value["provider"]["codedock"]["options"]["baseURL"],
            "https://api.example.com/v1"
        );
        // 密钥只能留占位符，绝不能出现在文件里
        assert_eq!(
            value["provider"]["codedock"]["options"]["apiKey"],
            "{env:CODEDOCK_AI_API_KEY}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn path_like_command_must_exist() {
        // 带分隔符的当路径处理，不存在就直接报错，不去 PATH 里瞎找
        let missing = if cfg!(windows) {
            "D:\\nope\\opencode.exe"
        } else {
            "/nope/opencode"
        };
        assert!(resolve_launch(missing, None).is_err());
    }

    #[test]
    fn empty_command_is_rejected() {
        assert!(resolve_launch("   ", None).is_err());
    }

    #[test]
    fn command_lookup_uses_explicit_path() {
        let dir = std::env::temp_dir().join(format!("codedock-agent-path-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        #[cfg(windows)]
        let executable = dir.join("opencode.cmd");
        #[cfg(not(windows))]
        let executable = dir.join("opencode");
        std::fs::write(&executable, b"placeholder").unwrap();
        let path = std::env::join_paths([dir.as_os_str()]).unwrap();

        assert!(resolve_launch("opencode", Some(path.as_os_str())).is_ok());
        assert!(resolve_launch("missing", Some(path.as_os_str())).is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
