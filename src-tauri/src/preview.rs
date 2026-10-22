//! 预览：探测工作区是什么项目，并托管一个预览进程。
//!
//! - web 项目：起 dev server，从日志 / 端口探测拿到地址，前端用内嵌浏览器看。
//! - Tauri 桌面项目：起 `tauri dev`，Windows 上给 WebView2 挂 `--remote-debugging-port`，
//!   前端拿这个 CDP 端口去驱动实例做验证。
//!
//! 进程池**按工作区 root 分片**，和 `agent::AgentState` 同一套做法：切走的工作区继续跑，
//! 应用退出时统一收掉。探测本身是纯函数（`detect_project`），不碰进程，便于单测。

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;
use tauri::Emitter;

use crate::agent::{self, ChildLog};
use crate::fs_api::FsState;
use crate::shell_env;

/// 预览进程自己退出时的事件名。前端 `onPreviewExit` 订阅它。
pub const EXIT_EVENT: &str = "preview-exit";

/// 等 dev server 就绪的时限。超时就不再主动探端口，只靠日志里出现的地址。
const READY_TIMEOUT: Duration = Duration::from_secs(30);

/// 后台线程的轮询间隔：既查就绪、也查退出。
const WATCH_INTERVAL: Duration = Duration::from_millis(500);

// ---- 对外数据结构 ----

/// 探测结果：这个工作区是什么项目、该怎么起、大概在哪个端口。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewDetection {
    /// "tauri" | "web" | "unknown"
    pub kind: String,
    pub package_manager: String,
    /// 展示用整行，如 "pnpm tauri dev"
    pub command: String,
    /// 解析后的可执行目标（"pnpm" 或绝对路径）
    pub program: String,
    pub args: Vec<String>,
    pub cwd: String,
    /// web 是 dev 端口；tauri 与 cdp_port 同值
    pub port: Option<u16>,
    /// web 才有：http://localhost:<port>
    pub url: Option<String>,
    /// tauri 才有：CDP 调试端口
    pub cdp_port: Option<u16>,
    /// 命中了哪些标记文件，界面上解释「为什么这么判」
    pub reason: String,
    /// 需要提醒用户的（如「这是 Codovo 自身」）
    pub warnings: Vec<String>,
}

/// 运行状态快照。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewStatus {
    pub running: bool,
    pub pid: Option<u32>,
    pub kind: String,
    pub command: String,
    pub cwd: String,
    pub url: Option<String>,
    pub cdp_port: Option<u16>,
    pub started_at: u64,
    pub logs: Vec<String>,
    pub exit_code: Option<i32>,
}

impl PreviewStatus {
    fn idle() -> Self {
        Self {
            running: false,
            pid: None,
            kind: String::new(),
            command: String::new(),
            cwd: String::new(),
            url: None,
            cdp_port: None,
            started_at: 0,
            logs: Vec::new(),
            exit_code: None,
        }
    }
}

// ---- 进程池 ----

struct PreviewRunning {
    child: Child,
    pid: u32,
    kind: String,
    command: String,
    cwd: PathBuf,
    url: Option<String>,
    cdp_port: Option<u16>,
    log: ChildLog,
    generation: u64,
    started_at: u64,
}

#[derive(Clone)]
struct Slot {
    inner: Arc<Mutex<Option<PreviewRunning>>>,
    generation: Arc<AtomicU64>,
}

/// 预览进程池，按工作区 root 分片。
pub struct PreviewState {
    slots: Mutex<HashMap<String, Slot>>,
}

impl PreviewState {
    pub fn new() -> Self {
        Self {
            slots: Mutex::new(HashMap::new()),
        }
    }

    fn slot(&self, root: &str) -> Slot {
        let mut slots = self.slots.lock().unwrap_or_else(|e| e.into_inner());
        slots
            .entry(root.to_string())
            .or_insert_with(|| Slot {
                inner: Arc::new(Mutex::new(None)),
                generation: Arc::new(AtomicU64::new(1)),
            })
            .clone()
    }

    /// 只查已有槽位，不创建——免得前端传来一个没起过预览的目录就凭空多一个空槽。
    fn peek(&self, root: &str) -> Option<Slot> {
        self.slots
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(root)
            .cloned()
    }

    /// 收掉某个工作区的预览进程。
    pub fn kill_workspace(&self, root: &str) {
        let removed = self
            .slots
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(root);
        if let Some(slot) = removed {
            slot.generation.fetch_add(1, Ordering::SeqCst);
            let running = slot.inner.lock().unwrap_or_else(|e| e.into_inner()).take();
            if let Some(mut running) = running {
                agent::kill_child(&mut running.child);
            }
        }
    }

    /// 应用退出时调用，别留下游离的 dev server。
    pub fn kill_all(&self) {
        let roots: Vec<String> = self
            .slots
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .keys()
            .cloned()
            .collect();
        for root in roots {
            self.kill_workspace(&root);
        }
    }
}

impl Default for PreviewState {
    fn default() -> Self {
        Self::new()
    }
}

/// 把某个槽位当前的状态拍成快照。
fn snapshot(state: &PreviewState, root: &str) -> PreviewStatus {
    let Some(slot) = state.peek(root) else {
        return PreviewStatus::idle();
    };
    let guard = slot.inner.lock().unwrap_or_else(|e| e.into_inner());
    match guard.as_ref() {
        Some(running) => PreviewStatus {
            running: true,
            pid: Some(running.pid),
            kind: running.kind.clone(),
            command: running.command.clone(),
            cwd: running.cwd.to_string_lossy().into_owned(),
            url: running.url.clone(),
            cdp_port: running.cdp_port,
            started_at: running.started_at,
            logs: running
                .log
                .lock()
                .map(|buffer| buffer.iter().cloned().collect())
                .unwrap_or_default(),
            exit_code: None,
        },
        None => PreviewStatus::idle(),
    }
}

// ---- 探测（纯函数，可单测）----

fn read_json(path: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn has_any(root: &Path, names: &[&str]) -> bool {
    names.iter().any(|name| root.join(name).is_file())
}

/// 按 lock 文件判包管理器。没有 package.json 就没有包管理器可言。
fn detect_package_manager(root: &Path) -> Option<&'static str> {
    if !root.join("package.json").is_file() {
        return None;
    }
    if root.join("pnpm-lock.yaml").is_file() {
        Some("pnpm")
    } else if root.join("yarn.lock").is_file() {
        Some("yarn")
    } else if root.join("bun.lockb").is_file() || root.join("bun.lock").is_file() {
        Some("bun")
    } else {
        Some("npm")
    }
}

fn pkg_has_dep(pkg: &Value, name: &str) -> bool {
    ["dependencies", "devDependencies"]
        .iter()
        .any(|key| pkg.get(key).and_then(|deps| deps.get(name)).is_some())
}

/// Tauri 的启动命令。pnpm/yarn/bun 直接跑依赖里的 bin；npm 得借 `run`。
fn tauri_command(pm: &str) -> (String, Vec<String>) {
    if pm == "npm" {
        (
            "npm".to_string(),
            vec![
                "run".to_string(),
                "tauri".to_string(),
                "--".to_string(),
                "dev".to_string(),
            ],
        )
    } else {
        (pm.to_string(), vec!["tauri".to_string(), "dev".to_string()])
    }
}

fn web_command(pm: &str, script: &str) -> (String, Vec<String>) {
    (
        pm.to_string(),
        vec!["run".to_string(), script.to_string()],
    )
}

fn format_command(program: &str, args: &[String]) -> String {
    if args.is_empty() {
        program.to_string()
    } else {
        format!("{program} {}", args.join(" "))
    }
}

/// 脚本里写死的 `--port N` / `-p N`。
fn find_port_flag(text: &str) -> Option<u16> {
    for flag in ["--port", "-p"] {
        if let Some(idx) = text.find(flag) {
            let after = &text[idx + flag.len()..];
            let digits: String = after
                .trim_start()
                .chars()
                .take_while(char::is_ascii_digit)
                .collect();
            if !digits.is_empty() {
                if let Ok(value) = digits.parse::<u16>() {
                    return Some(value);
                }
            }
        }
    }
    None
}

/// 配置文件里 `port: 5173` / `port = 5173` 这种写法。手写扫描，不引正则。
fn find_config_port(text: &str) -> Option<u16> {
    let bytes = text.as_bytes();
    let mut i = 0;
    while i + 4 <= bytes.len() {
        if &bytes[i..i + 4] == b"port" {
            let mut j = i + 4;
            while j < bytes.len() && (bytes[j] == b' ' || bytes[j] == b'\t') {
                j += 1;
            }
            if j < bytes.len() && (bytes[j] == b':' || bytes[j] == b'=') {
                j += 1;
                while j < bytes.len() && (bytes[j] == b' ' || bytes[j] == b'\t') {
                    j += 1;
                }
                let start = j;
                while j < bytes.len() && bytes[j].is_ascii_digit() {
                    j += 1;
                }
                if j > start {
                    if let Ok(value) = text[start..j].parse::<u16>() {
                        return Some(value);
                    }
                }
            }
        }
        i += 1;
    }
    None
}

/// 框架默认端口，兜在最后。
fn framework_default_port(root: &Path) -> Option<u16> {
    if has_any(
        root,
        &[
            "vite.config.ts",
            "vite.config.js",
            "vite.config.mjs",
            "vite.config.mts",
        ],
    ) {
        return Some(5173);
    }
    if has_any(
        root,
        &["next.config.js", "next.config.mjs", "next.config.ts"],
    ) {
        return Some(3000);
    }
    if has_any(root, &["nuxt.config.ts", "nuxt.config.js"]) {
        return Some(3000);
    }
    None
}

/// 推断 dev 端口：脚本参数 > 配置文件 > 框架默认。
fn infer_port(root: &Path, script_body: &str) -> Option<u16> {
    if let Some(port) = find_port_flag(script_body) {
        return Some(port);
    }
    for name in [
        "vite.config.ts",
        "vite.config.js",
        "vite.config.mjs",
        "vite.config.mts",
    ] {
        if let Ok(text) = std::fs::read_to_string(root.join(name)) {
            if let Some(port) = find_config_port(&text) {
                return Some(port);
            }
        }
    }
    framework_default_port(root)
}

/// 从 dev server 的一行输出里抠出地址，如 `➜  Local:   http://localhost:5173/`。
fn parse_dev_url(line: &str) -> Option<String> {
    for token in line.split_whitespace() {
        let token = token.trim_matches(|c: char| {
            c == '"' || c == '\'' || c == ')' || c == ',' || c == ']'
        });
        for prefix in [
            "http://localhost:",
            "http://127.0.0.1:",
            "http://[::1]:",
        ] {
            if let Some(rest) = token.strip_prefix(prefix) {
                let port: String = rest.chars().take_while(char::is_ascii_digit).collect();
                if !port.is_empty() {
                    return Some(format!("{prefix}{port}"));
                }
            }
        }
    }
    None
}

/// 「这是 Codovo 自身」的告警：自预览会撞单实例锁和 CDP 端口。
fn self_preview_warning(pkg: Option<&Value>, tauri_conf: Option<&Value>) -> Option<String> {
    let by_name = pkg
        .and_then(|p| p.get("name"))
        .and_then(Value::as_str)
        .map(|name| name == "codovo")
        .unwrap_or(false);
    let by_identifier = tauri_conf
        .and_then(|c| c.get("identifier"))
        .and_then(Value::as_str)
        .map(|id| id.starts_with("com.codovo"))
        .unwrap_or(false);
    if by_name || by_identifier {
        Some(
            "这是 Codovo 自身：启动预览会与当前运行实例争抢单实例锁 / CDP 调试端口，很可能起不来"
                .to_string(),
        )
    } else {
        None
    }
}

/// 探测工作区项目类型，给出启动命令与端口。
fn detect_project(root: &Path) -> PreviewDetection {
    let cwd = root.to_string_lossy().into_owned();
    let pkg = read_json(&root.join("package.json"));
    let tauri_conf = read_json(&root.join("src-tauri").join("tauri.conf.json"));
    let pm = detect_package_manager(root);
    let mut warnings = Vec::new();

    // 1. Tauri 桌面
    let tauri_by_conf = root.join("src-tauri").join("tauri.conf.json").is_file();
    let tauri_by_dep = pkg
        .as_ref()
        .map(|p| pkg_has_dep(p, "@tauri-apps/cli") || pkg_has_dep(p, "@tauri-apps/api"))
        .unwrap_or(false);
    if tauri_by_conf || tauri_by_dep {
        if let Some(warning) = self_preview_warning(pkg.as_ref(), tauri_conf.as_ref()) {
            warnings.push(warning);
        }
        let pm = pm.unwrap_or("npm");
        let (program, args) = tauri_command(pm);
        let cdp = agent::free_port().ok();
        return PreviewDetection {
            kind: "tauri".to_string(),
            package_manager: pm.to_string(),
            command: format_command(&program, &args),
            program,
            args,
            cwd,
            port: cdp,
            url: None,
            cdp_port: cdp,
            reason: if tauri_by_conf {
                "检测到 src-tauri/tauri.conf.json".to_string()
            } else {
                "package.json 依赖里有 @tauri-apps/cli".to_string()
            },
            warnings,
        };
    }

    // 2. web（有 dev / start 脚本）
    if let Some(pkg) = pkg.as_ref() {
        let scripts = pkg.get("scripts");
        let dev = scripts.and_then(|s| s.get("dev")).and_then(Value::as_str);
        let start = scripts.and_then(|s| s.get("start")).and_then(Value::as_str);
        if let Some((name, body)) = dev
            .map(|b| ("dev", b))
            .or_else(|| start.map(|b| ("start", b)))
        {
            let pm = pm.unwrap_or("npm");
            let (program, args) = web_command(pm, name);
            let port = infer_port(root, body);
            let url = port.map(|p| format!("http://localhost:{p}"));
            return PreviewDetection {
                kind: "web".to_string(),
                package_manager: pm.to_string(),
                command: format_command(&program, &args),
                program,
                args,
                cwd,
                port,
                url,
                cdp_port: None,
                reason: format!("package.json 有 scripts.{name}"),
                warnings,
            };
        }
    }

    // 3. 认不出来
    PreviewDetection {
        kind: "unknown".to_string(),
        package_manager: pm.unwrap_or("").to_string(),
        command: String::new(),
        program: String::new(),
        args: Vec::new(),
        cwd,
        port: None,
        url: None,
        cdp_port: None,
        reason: if pm.is_none() {
            "没找到 package.json / src-tauri，无法判断项目类型".to_string()
        } else {
            "package.json 里没有 dev / start 脚本".to_string()
        },
        warnings,
    }
}

// ---- 起 / 监视进程 ----

/// 把用户手填的一整行命令拆成 program + args。按空白拆，v1 不处理引号里的空格。
fn split_command(command: &str) -> Result<(String, Vec<String>), String> {
    let mut parts = command.split_whitespace().map(str::to_string);
    let program = parts.next().ok_or_else(|| "启动命令为空".to_string())?;
    Ok((program, parts.collect()))
}

fn spawn_preview(
    program: &str,
    args: &[String],
    cwd: &Path,
    cdp_port: Option<u16>,
    log: ChildLog,
) -> Result<Child, String> {
    let path = shell_env::resolved_path(&shell_env::default_shell(), Some(cwd));
    let program_path = if program.contains('/') || program.contains('\\') {
        let candidate = PathBuf::from(program);
        if !candidate.is_file() {
            return Err(format!("找不到可执行文件：{program}"));
        }
        candidate
    } else {
        agent::find_on_path(program, path.as_deref())
            .ok_or_else(|| format!("在 PATH 里找不到 {program}，请先安装"))?
    };

    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let mut cmd = if agent::needs_cmd_wrapper(&program_path) {
        agent::wrap_with_cmd(&program_path, &arg_refs)
    } else {
        let mut direct = Command::new(&program_path);
        direct.args(&arg_refs);
        direct
    };

    if let Some(path) = path {
        cmd.env("PATH", path);
    }
    cmd.current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Tauri 桌面：给 WebView2 挂调试端口，前端才能用 CDP 驱动这个实例
    #[cfg(windows)]
    {
        if let Some(port) = cdp_port {
            cmd.env(
                "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
                format!("--remote-debugging-port={port}"),
            );
        }
    }
    #[cfg(not(windows))]
    let _ = cdp_port;

    agent::hide_console(&mut cmd);

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    let mut child = cmd.spawn().map_err(|e| format!("启动预览失败: {e}"))?;
    if let Some(stdout) = child.stdout.take() {
        agent::pump_child_log(stdout, Arc::clone(&log));
    }
    if let Some(stderr) = child.stderr.take() {
        agent::pump_child_log(stderr, Arc::clone(&log));
    }
    Ok(child)
}

/// 后台线程：探就绪（补 URL）+ 盯退出（清槽 + 发事件）。
fn spawn_watcher(
    app: tauri::AppHandle,
    slot: Slot,
    root: String,
    generation: u64,
    probe_port: Option<u16>,
) {
    std::thread::spawn(move || {
        let deadline = Instant::now() + READY_TIMEOUT;
        loop {
            std::thread::sleep(WATCH_INTERVAL);

            let mut guard = match slot.inner.lock() {
                Ok(guard) => guard,
                Err(_) => return,
            };
            let Some(running) = guard.as_mut() else {
                return;
            };
            // 已经被换掉或停掉了，收工
            if running.generation != generation {
                return;
            }

            // 补 URL：优先日志里出现的真实地址，其次探推断端口
            if running.url.is_none() {
                if let Ok(buffer) = running.log.lock() {
                    if let Some(url) = buffer.iter().rev().find_map(|line| parse_dev_url(line)) {
                        running.url = Some(url);
                    }
                }
            }
            if running.url.is_none() && Instant::now() < deadline {
                if let Some(port) = probe_port {
                    if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
                        running.url = Some(format!("http://localhost:{port}"));
                    }
                }
            }

            // 退出检测
            match running.child.try_wait() {
                Ok(Some(status)) => {
                    let code = status.code().unwrap_or(-1);
                    guard.take();
                    slot.generation.fetch_add(1, Ordering::SeqCst);
                    drop(guard);
                    let _ = app.emit(
                        EXIT_EVENT,
                        serde_json::json!({ "root": root, "code": code }),
                    );
                    return;
                }
                Ok(None) => {}
                Err(_) => {
                    guard.take();
                    slot.generation.fetch_add(1, Ordering::SeqCst);
                    drop(guard);
                    let _ = app.emit(
                        EXIT_EVENT,
                        serde_json::json!({ "root": root, "code": -1 }),
                    );
                    return;
                }
            }
        }
    });
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---- Tauri 命令 ----

/// 探测工作区的预览方式，不启动任何进程。
#[tauri::command]
pub fn preview_detect(
    fs: tauri::State<'_, FsState>,
    root: String,
) -> Result<PreviewDetection, String> {
    let root = fs.checked_root(&root)?;
    Ok(detect_project(&root))
}

/// 启动预览。已在跑的先停掉（幂等）。`command` / `port` 是用户覆盖值。
#[tauri::command]
pub fn preview_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, PreviewState>,
    fs: tauri::State<'_, FsState>,
    root: String,
    command: Option<String>,
    port: Option<u16>,
) -> Result<PreviewStatus, String> {
    let root_path = fs.checked_root(&root)?;
    state.kill_workspace(&root);

    let detection = detect_project(&root_path);
    let (program, args) = match command
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        Some(text) => split_command(text)?,
        None => {
            if detection.program.is_empty() {
                return Err("没能识别出这个项目的启动命令，请手动填写".to_string());
            }
            (detection.program.clone(), detection.args.clone())
        }
    };

    let kind = detection.kind.clone();
    // 用户指定的端口优先，否则用探测结果
    let port = port.or(detection.port);
    // Tauri 的「端口」就是 CDP 端口；web 的端口是 dev 端口
    let cdp_port = if kind == "tauri" {
        detection.cdp_port.or(port)
    } else {
        None
    };
    let probe_port = if kind == "web" { port } else { None };
    let command_text = format_command(&program, &args);

    let slot = state.slot(&root);
    let generation = slot.generation.fetch_add(1, Ordering::SeqCst) + 1;

    let log: ChildLog = Arc::new(Mutex::new(VecDeque::new()));
    let child = spawn_preview(&program, &args, &root_path, cdp_port, Arc::clone(&log))?;
    let pid = child.id();

    let running = PreviewRunning {
        child,
        pid,
        kind,
        command: command_text,
        cwd: root_path,
        url: None,
        cdp_port,
        log,
        generation,
        started_at: now_millis(),
    };
    *slot.inner.lock().unwrap_or_else(|e| e.into_inner()) = Some(running);

    spawn_watcher(app, slot, root.clone(), generation, probe_port);

    Ok(snapshot(&state, &root))
}

/// 停止某个工作区的预览进程。
#[tauri::command]
pub fn preview_stop(state: tauri::State<'_, PreviewState>, root: String) {
    state.kill_workspace(&root);
}

/// 查预览状态（含最近日志）。
#[tauri::command]
pub fn preview_status(state: tauri::State<'_, PreviewState>, root: String) -> PreviewStatus {
    snapshot(&state, &root)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "codovo-preview-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn detects_tauri_project() {
        let dir = temp_dir("tauri");
        std::fs::create_dir_all(dir.join("src-tauri")).unwrap();
        std::fs::write(
            dir.join("src-tauri").join("tauri.conf.json"),
            r#"{ "identifier": "com.example.app" }"#,
        )
        .unwrap();
        std::fs::write(
            dir.join("package.json"),
            r#"{ "name": "demo", "devDependencies": { "@tauri-apps/cli": "^2" } }"#,
        )
        .unwrap();
        std::fs::write(dir.join("pnpm-lock.yaml"), "").unwrap();

        let detected = detect_project(&dir);
        assert_eq!(detected.kind, "tauri");
        assert_eq!(detected.package_manager, "pnpm");
        assert_eq!(detected.command, "pnpm tauri dev");
        assert!(detected.cdp_port.is_some());
        assert!(detected.warnings.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn detects_web_project_and_infers_port_from_script() {
        let dir = temp_dir("web-script");
        std::fs::write(
            dir.join("package.json"),
            r#"{ "name": "site", "scripts": { "dev": "vite --port 4321" } }"#,
        )
        .unwrap();
        std::fs::write(dir.join("pnpm-lock.yaml"), "").unwrap();

        let detected = detect_project(&dir);
        assert_eq!(detected.kind, "web");
        assert_eq!(detected.package_manager, "pnpm");
        assert_eq!(detected.command, "pnpm run dev");
        assert_eq!(detected.port, Some(4321));
        assert_eq!(detected.url.as_deref(), Some("http://localhost:4321"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn falls_back_to_vite_default_port() {
        let dir = temp_dir("web-vite");
        std::fs::write(
            dir.join("package.json"),
            r#"{ "name": "site", "scripts": { "dev": "vite" } }"#,
        )
        .unwrap();
        std::fs::write(dir.join("vite.config.ts"), "export default {}").unwrap();

        let detected = detect_project(&dir);
        assert_eq!(detected.kind, "web");
        assert_eq!(detected.port, Some(5173));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reads_port_from_vite_config() {
        let dir = temp_dir("web-config");
        std::fs::write(
            dir.join("package.json"),
            r#"{ "name": "site", "scripts": { "dev": "vite" } }"#,
        )
        .unwrap();
        std::fs::write(
            dir.join("vite.config.ts"),
            "export default { server: { port: 8888 } }",
        )
        .unwrap();

        let detected = detect_project(&dir);
        assert_eq!(detected.port, Some(8888));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unknown_when_no_markers() {
        let dir = temp_dir("unknown");
        let detected = detect_project(&dir);
        assert_eq!(detected.kind, "unknown");
        assert!(detected.program.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn warns_when_previewing_codovo_itself() {
        let dir = temp_dir("self");
        std::fs::create_dir_all(dir.join("src-tauri")).unwrap();
        std::fs::write(
            dir.join("src-tauri").join("tauri.conf.json"),
            r#"{ "identifier": "com.codovo" }"#,
        )
        .unwrap();
        std::fs::write(dir.join("package.json"), r#"{ "name": "codovo" }"#).unwrap();

        let detected = detect_project(&dir);
        assert_eq!(detected.kind, "tauri");
        assert_eq!(detected.warnings.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parses_dev_server_url_from_log_line() {
        assert_eq!(
            parse_dev_url("  ➜  Local:   http://localhost:5173/").as_deref(),
            Some("http://localhost:5173")
        );
        assert_eq!(
            parse_dev_url("- Local: http://127.0.0.1:3000").as_deref(),
            Some("http://127.0.0.1:3000")
        );
        assert_eq!(parse_dev_url("no url here"), None);
    }

    #[test]
    fn finds_port_flag_and_config_port() {
        assert_eq!(find_port_flag("vite --port 1234"), Some(1234));
        assert_eq!(find_port_flag("next dev -p 4000"), Some(4000));
        assert_eq!(find_port_flag("vite"), None);
        assert_eq!(find_config_port("server: { port: 5555 }"), Some(5555));
        assert_eq!(find_config_port("no port"), None);
    }

    #[test]
    fn splits_command_line() {
        let (program, args) = split_command("pnpm run dev").unwrap();
        assert_eq!(program, "pnpm");
        assert_eq!(args, vec!["run".to_string(), "dev".to_string()]);
        assert!(split_command("   ").is_err());
    }

    #[test]
    fn idle_status_when_never_started() {
        let state = PreviewState::new();
        let status = snapshot(&state, "/nonexistent");
        assert!(!status.running);
        assert!(status.pid.is_none());
    }
}
