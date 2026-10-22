//! CICD 部署模块：读 / 写项目根 `.local-cicd.yaml`，按「Preflight → Build → Deploy → Verify」
//! 跑一条最小本地流水线，失败即停。
//!
//! 对齐本机的 local-cicd 技能：
//! - 配置放项目根 `.local-cicd.yaml`（字段留空走自动探测）；
//! - 运行时产物落项目根 `.local-cicd/`（releases/、current、log/），该目录已随仓库忽略；
//! - 只做单机单环境，不做远程 / 多环境 / 审批。
//!
//! 阶段输出经 `tauri::ipc::Channel` 流式推给前端（照 `pty.rs` / `remote.rs` 的做法），
//! 子进程用 `agent::hide_console` 隐藏 Windows 控制台。

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

/// 配置文件（项目根）
const CONFIG_FILE: &str = ".local-cicd.yaml";
/// 运行时产物目录（项目根，已随仓库忽略）
const STATE_DIR: &str = ".local-cicd";
/// 阶段名。与前端阶段条的 id 一一对应。
const STAGE_PREFLIGHT: &str = "preflight";
const STAGE_BUILD: &str = "build";
const STAGE_DEPLOY: &str = "deploy";
const STAGE_VERIFY: &str = "verify";
const STAGE_ROLLBACK: &str = "rollback";
/// 单次运行保留的日志行上限，防止刷屏命令把内存吃满
const MAX_LOG_LINES: usize = 20_000;
/// 等就绪的默认秒数
const DEFAULT_READY_TIMEOUT: u64 = 30;

// ---------- 配置模型 ----------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DeployConfig {
    #[serde(default)]
    pub workdir: Option<String>,
    #[serde(default)]
    pub stop: String,
    #[serde(default)]
    pub start: String,
    /// 桌面 / 客户端应用的静默安装命令（与 start 二选一）
    #[serde(default)]
    pub install: String,
    /// 安装前先关闭的进程名（可多个，逗号分隔）；留空不杀任何进程
    #[serde(default)]
    pub install_kill: String,
    #[serde(default)]
    pub ready_timeout: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct VerifyConfig {
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub timeout: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CicdConfig {
    #[serde(default)]
    pub version: Option<u32>,
    #[serde(default)]
    pub install: String,
    /// Build 前执行的清理命令（改动会被嵌进制品的外部资源时必填）
    #[serde(default)]
    pub clean: String,
    #[serde(default)]
    pub build: String,
    #[serde(default)]
    pub deploy: DeployConfig,
    #[serde(default)]
    pub verify: VerifyConfig,
    /// 运行时环境变量。值用 `Value` 接，数字 / 布尔也能原样转字符串
    #[serde(default)]
    pub env: HashMap<String, serde_yaml::Value>,
    /// 保留最近几个可回滚版本
    #[serde(default)]
    pub keep_releases: Option<u32>,
}

impl CicdConfig {
    fn env_strings(&self) -> HashMap<String, String> {
        self.env
            .iter()
            .map(|(key, value)| (key.clone(), yaml_scalar(value)))
            .collect()
    }
}

/// 把 YAML 标量转成字符串；数字 / 布尔 / null 都照原样，复合值退化成紧凑文本
fn yaml_scalar(value: &serde_yaml::Value) -> String {
    match value {
        serde_yaml::Value::String(text) => text.clone(),
        serde_yaml::Value::Number(number) => number.to_string(),
        serde_yaml::Value::Bool(flag) => flag.to_string(),
        serde_yaml::Value::Null => String::new(),
        other => serde_yaml::to_string(other)
            .unwrap_or_default()
            .trim()
            .to_string(),
    }
}

// ---------- 事件与状态 ----------

/// 流水线事件。前端按 `type` 分派：阶段开始 / 命令输出 / 阶段结束 / 整条结束。
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CicdEvent {
    /// 某个阶段开始（带这一阶段的命令文本）
    StageStart { stage: String, command: String },
    /// 命令输出一行
    Output { stage: String, stream: String, line: String },
    /// 某个阶段结束
    StageEnd {
        stage: String,
        ok: bool,
        code: i32,
        duration_ms: u64,
    },
    /// 整条流水线结束
    Finished {
        ok: bool,
        rolled_back: bool,
        message: String,
    },
}

#[derive(Serialize)]
pub struct ConfigFile {
    pub path: String,
    pub exists: bool,
    pub yaml: String,
}

#[derive(Serialize)]
pub struct CicdStatus {
    pub running: bool,
    pub current_version: Option<String>,
}

/// 一次运行的控制块：`cancelled` 让停止命令打断轮询，`child` 让停止命令能 kill 当前进程。
struct RunHandle {
    child: Arc<Mutex<Option<Child>>>,
    cancelled: Arc<AtomicBool>,
}

impl RunHandle {
    fn new() -> Self {
        Self {
            child: Arc::new(Mutex::new(None)),
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }

    fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        if let Ok(mut slot) = self.child.lock() {
            if let Some(child) = slot.as_mut() {
                let _ = child.kill();
            }
        }
    }
}

pub struct CicdState {
    /// 工作区根 -> 正在跑的流水线。同一根同时只允许一条。
    runs: Arc<Mutex<HashMap<String, Arc<RunHandle>>>>,
}

impl CicdState {
    pub fn new() -> Self {
        Self {
            runs: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// 应用退出时调用：打断所有在跑的流水线并 kill 当前子进程。
    pub fn kill_all(&self) {
        let runs = match self.runs.lock() {
            Ok(runs) => runs,
            Err(_) => return,
        };
        for handle in runs.values() {
            handle.cancel();
        }
    }
}

// ---------- 路径与版本 ----------

fn config_path(root: &Path) -> PathBuf {
    root.join(CONFIG_FILE)
}

fn state_dir(root: &Path) -> PathBuf {
    root.join(STATE_DIR)
}

/// 版本号：优先 git 短 sha，无 git 时用毫秒时间戳
fn current_version(root: &Path) -> String {
    let mut cmd = Command::new("git");
    cmd.arg("rev-parse").arg("--short").arg("HEAD");
    cmd.current_dir(root);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    crate::agent::hide_console(&mut cmd);
    if let Ok(output) = cmd.output() {
        if output.status.success() {
            let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !text.is_empty() {
                return text;
            }
        }
    }
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("t{millis}")
}

/// 读 `.local-cicd/current`（记录当前部署版本号）
fn read_current(root: &Path) -> Option<String> {
    let text = std::fs::read_to_string(state_dir(root).join("current")).ok()?;
    let trimmed = text.trim().to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

// ---------- 项目标记探测 ----------

/// 探测项目类型，生成一份建议配置（YAML 文本）。探测不到时给一份带注释的空模板。
fn suggest_config_yaml(root: &Path) -> String {
    let has = |name: &str| root.join(name).is_file();

    let mut install = String::new();
    let mut build = String::new();
    let mut start = String::new();
    let mut install_cmd = String::new();
    let mut install_kill = String::new();
    let mut reason = "未识别出项目标记，请手动填写各阶段命令".to_string();

    if has("package.json") {
        let pm = detect_package_manager(root);
        let run = pm.run;
        install = format!("{} install", pm.install);
        build = format!("{run} build");
        start = format!("{run} start");
        reason = format!("检测到 package.json（{}）", pm.name);
    } else if has("Cargo.toml") {
        build = "cargo build --release".to_string();
        reason = "检测到 Cargo.toml".to_string();
    } else if has("go.mod") {
        install = "go mod download".to_string();
        build = "go build -o app .".to_string();
        reason = "检测到 go.mod".to_string();
    } else if has("pyproject.toml") || has("requirements.txt") {
        install = "pip install -e .".to_string();
        reason = "检测到 Python 项目标记".to_string();
    } else if has("pom.xml") {
        build = "mvn -q -DskipTests package".to_string();
        reason = "检测到 pom.xml".to_string();
    } else if has("build.gradle") || has("build.gradle.kts") {
        build = "gradle build".to_string();
        reason = "检测到 Gradle 项目标记".to_string();
    } else if has("Dockerfile") || has("compose.yaml") || has("docker-compose.yml") {
        build = "docker build -t app .".to_string();
        start = "docker compose up -d".to_string();
        reason = "检测到容器项目标记".to_string();
    } else if has("Makefile") {
        install = "make install".to_string();
        build = "make build".to_string();
        start = "make run".to_string();
        reason = "检测到 Makefile".to_string();
    }

    // 探测到 Tauri 桌面应用时改用静默安装（本机部署的典型形态）
    let tauri = root.join("src-tauri").join("tauri.conf.json").is_file();
    if tauri && install_cmd.is_empty() && start.is_empty() {
        reason = format!("{reason}；检测到 src-tauri/tauri.conf.json（桌面应用，建议填 deploy.install）");
    }
    let _ = &mut install_cmd;
    let _ = &mut install_kill;

    let verify_url = if start.contains("npm") || build.contains("npm") {
        "http://127.0.0.1:3000/".to_string()
    } else {
        String::new()
    };

    format!(
        "# .local-cicd.yaml —— 由 Codovo 按项目标记探测生成，请按实际情况调整\n\
         # 字段留空即跳过该阶段。详见本机 local-cicd 技能。\n\
         # 探测依据：{reason}\n\
         version: 1\n\
         install: {install}\n\
         clean: \"\"\n\
         build: {build}\n\
         deploy:\n\
         \x20 workdir: \".\"\n\
         \x20 stop: \"\"\n\
         \x20 start: {start}\n\
         \x20 install: \"\"\n\
         \x20 install_kill: \"\"\n\
         \x20 ready_timeout: 30\n\
         verify:\n\
         \x20 url: {verify_url}\n\
         \x20 command: \"\"\n\
         \x20 timeout: 10\n\
         env: {{}}\n\
         keep_releases: 3\n",
        install = yaml_quote(&install),
        build = yaml_quote(&build),
        start = yaml_quote(&start),
        verify_url = yaml_quote(&verify_url),
        reason = reason,
    )
}

/// 空串要写成 `""`，否则 YAML 里 `install:` 是 null、反序列化到 String 会失败
fn yaml_quote(value: &str) -> String {
    if value.is_empty() {
        "\"\"".to_string()
    } else {
        format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
    }
}

struct PackageManager {
    name: &'static str,
    /// 安装依赖的命令前缀
    install: &'static str,
    /// 跑脚本的前缀，如 `pnpm run`
    run: String,
}

fn detect_package_manager(root: &Path) -> PackageManager {
    let has = |name: &str| root.join(name).is_file();
    if has("pnpm-lock.yaml") {
        PackageManager {
            name: "pnpm",
            install: "pnpm",
            run: "pnpm run".to_string(),
        }
    } else if has("yarn.lock") {
        PackageManager {
            name: "yarn",
            install: "yarn",
            run: "yarn".to_string(),
        }
    } else if has("bun.lockb") {
        PackageManager {
            name: "bun",
            install: "bun",
            run: "bun run".to_string(),
        }
    } else {
        PackageManager {
            name: "npm",
            install: "npm",
            run: "npm run".to_string(),
        }
    }
}

// ---------- 命令执行 ----------

/// 按平台包一层 shell：Windows `cmd /C`，其余 `sh -c`
fn build_command(command: &str) -> Command {
    #[cfg(windows)]
    {
        let mut cmd = Command::new("cmd");
        cmd.arg("/C").arg(command);
        cmd
    }
    #[cfg(not(windows))]
    {
        let mut cmd = Command::new("sh");
        cmd.arg("-c").arg(command);
        cmd
    }
}

/// 流水线执行器：持有日志缓冲、channel、取消句柄，串行跑各阶段命令。
struct Runner<'a> {
    root: &'a Path,
    workdir: PathBuf,
    env: HashMap<String, String>,
    handle: &'a Arc<RunHandle>,
    channel: &'a Channel<CicdEvent>,
    log: Arc<Mutex<Vec<String>>>,
}

impl<'a> Runner<'a> {
    fn cancelled(&self) -> bool {
        self.handle.cancelled.load(Ordering::SeqCst)
    }

    fn push_log(&self, line: String) {
        if let Ok(mut log) = self.log.lock() {
            if log.len() < MAX_LOG_LINES {
                log.push(line);
            }
        }
    }

    fn stage_start(&self, stage: &str, command: &str) {
        let _ = self.channel.send(CicdEvent::StageStart {
            stage: stage.to_string(),
            command: command.to_string(),
        });
        self.push_log(format!("[{stage}] $ {command}"));
    }

    fn stage_end(&self, stage: &str, ok: bool, code: i32, duration_ms: u64) {
        let _ = self.channel.send(CicdEvent::StageEnd {
            stage: stage.to_string(),
            ok,
            code,
            duration_ms,
        });
        self.push_log(format!(
            "[{stage}] {} (code={code}, {duration_ms}ms)",
            if ok { "成功" } else { "失败" }
        ));
    }

    /// 跑一条命令并等它结束，输出逐行推给前端。返回退出码；被取消返回 `-1`。
    fn run_command(&self, stage: &str, command: &str) -> Result<i32, String> {
        let command = command.trim();
        if command.is_empty() {
            return Ok(0);
        }
        self.stage_start(stage, command);
        let started = Instant::now();

        let mut cmd = build_command(command);
        cmd.current_dir(&self.workdir);
        cmd.envs(&self.env);
        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        crate::agent::hide_console(&mut cmd);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }

        let mut child = cmd.spawn().map_err(|e| format!("启动命令失败: {e}"))?;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        let mut readers = Vec::new();
        if let Some(out) = stdout {
            readers.push(spawn_line_reader(
                out,
                self.channel.clone(),
                stage.to_string(),
                "stdout",
                Arc::clone(&self.log),
            ));
        }
        if let Some(err) = stderr {
            readers.push(spawn_line_reader(
                err,
                self.channel.clone(),
                stage.to_string(),
                "stderr",
                Arc::clone(&self.log),
            ));
        }

        // 把子进程放进取消句柄，停止命令才能 kill 它
        if let Ok(mut slot) = self.handle.child.lock() {
            *slot = Some(child);
        }

        let code = loop {
            if self.cancelled() {
                if let Ok(mut slot) = self.handle.child.lock() {
                    if let Some(proc) = slot.as_mut() {
                        let _ = proc.kill();
                    }
                }
                break -1;
            }
            let mut slot = self.handle.child.lock().map_err(|e| e.to_string())?;
            match slot.as_mut() {
                Some(proc) => match proc.try_wait() {
                    Ok(Some(status)) => break status.code().unwrap_or(-1),
                    Ok(None) => {}
                    Err(_) => break -1,
                },
                None => break -1,
            }
            drop(slot);
            std::thread::sleep(Duration::from_millis(50));
        };

        // 清掉句柄，并等读取线程把剩余输出吐完
        if let Ok(mut slot) = self.handle.child.lock() {
            *slot = None;
        }
        for reader in readers {
            let _ = reader.join();
        }

        let duration_ms = started.elapsed().as_millis() as u64;
        self.stage_end(stage, code == 0, code, duration_ms);
        Ok(code)
    }

    /// 后台启动一条常驻命令（服务型 deploy.start）。输出重定向到 `.local-cicd/log/run.log`，
    /// 起完即返回、不等它退出——服务本来就该常驻。
    fn spawn_background(&self, stage: &str, command: &str) -> Result<(), String> {
        let command = command.trim();
        if command.is_empty() {
            return Ok(());
        }
        let log_dir = state_dir(self.root).join("log");
        std::fs::create_dir_all(&log_dir).map_err(|e| format!("创建日志目录失败: {e}"))?;
        let log_file = log_dir.join("run.log");
        let stdout =
            std::fs::File::create(&log_file).map_err(|e| format!("创建日志文件失败: {e}"))?;
        let stderr = stdout
            .try_clone()
            .map_err(|e| format!("复制日志句柄失败: {e}"))?;

        self.stage_start(stage, command);
        let started = Instant::now();

        let mut cmd = build_command(command);
        cmd.current_dir(&self.workdir);
        cmd.envs(&self.env);
        cmd.stdin(Stdio::null())
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr));
        crate::agent::hide_console(&mut cmd);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }

        // 只 spawn、不 wait：服务进程继续在后台跑，drop 掉 Child 也不会杀它。
        // 起没起得来交给 Verify 兜底（探端口 / 跑命令）。
        let child = cmd.spawn().map_err(|e| format!("启动命令失败: {e}"))?;
        drop(child);
        let duration_ms = started.elapsed().as_millis() as u64;
        self.stage_end(stage, true, 0, duration_ms);
        Ok(())
    }

    /// 探 TCP 端口直到通或超时。`verify.url` 就绪判据用它。
    fn wait_for_port(&self, stage: &str, url: &str, timeout_secs: u64) -> Result<(), String> {
        let Some(addr) = url_to_addr(url) else {
            return Err(format!("无法从 URL 解析出地址: {url}"));
        };
        self.stage_start(stage, &format!("等待 {addr} 就绪"));
        let started = Instant::now();
        let deadline = started + Duration::from_secs(timeout_secs.max(1));
        loop {
            if self.cancelled() {
                return Err("已取消".into());
            }
            if std::net::TcpStream::connect(&addr).is_ok() {
                let duration_ms = started.elapsed().as_millis() as u64;
                self.stage_end(stage, true, 0, duration_ms);
                return Ok(());
            }
            if Instant::now() >= deadline {
                let duration_ms = started.elapsed().as_millis() as u64;
                self.stage_end(stage, false, -1, duration_ms);
                return Err(format!("等待 {addr} 就绪超时（{timeout_secs}s）"));
            }
            std::thread::sleep(Duration::from_millis(300));
        }
    }
}

/// 逐行读子进程输出并推给前端，同时写进日志缓冲
fn spawn_line_reader(
    stream: impl std::io::Read + Send + 'static,
    channel: Channel<CicdEvent>,
    stage: String,
    kind: &'static str,
    log: Arc<Mutex<Vec<String>>>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let reader = BufReader::new(stream);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            let _ = channel.send(CicdEvent::Output {
                stage: stage.clone(),
                stream: kind.to_string(),
                line: line.clone(),
            });
            if let Ok(mut log) = log.lock() {
                if log.len() < MAX_LOG_LINES {
                    log.push(line);
                }
            }
        }
    })
}

/// 从 URL 里抠出 host:port；没写端口时按 http/https 补默认端口
fn url_to_addr(url: &str) -> Option<String> {
    let rest = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"))
        .unwrap_or(url);
    let authority = rest.split(['/', '?']).next()?.trim();
    if authority.is_empty() {
        return None;
    }
    if authority.contains(':') {
        Some(authority.to_string())
    } else if url.starts_with("https://") {
        Some(format!("{authority}:443"))
    } else {
        Some(format!("{authority}:80"))
    }
}

// ---------- 流水线 ----------

fn execute_pipeline(
    root: &Path,
    handle: &Arc<RunHandle>,
    channel: &Channel<CicdEvent>,
) -> (bool, bool, String) {
    let path = config_path(root);
    let config = match std::fs::read_to_string(&path) {
        Ok(text) => match serde_yaml::from_str::<CicdConfig>(&text) {
            Ok(config) => config,
            Err(error) => {
                return (false, false, format!("{CONFIG_FILE} 解析失败: {error}"));
            }
        },
        Err(error) => {
            return (false, false, format!("读取 {CONFIG_FILE} 失败: {error}"));
        }
    };

    let workdir = config
        .deploy
        .workdir
        .as_deref()
        .map(|dir| {
            let candidate = root.join(dir);
            if candidate.is_dir() {
                candidate
            } else {
                root.to_path_buf()
            }
        })
        .unwrap_or_else(|| root.to_path_buf());

    let log = Arc::new(Mutex::new(Vec::new()));
    let runner = Runner {
        root,
        workdir: workdir.clone(),
        env: config.env_strings(),
        handle,
        channel,
        log: Arc::clone(&log),
    };

    let result = run_stages(&runner, &config);

    // 落日志 + 写版本快照 / current
    let version = current_version(root);
    let _ = write_run_log(root, &version, &log);
    let rolled_back = match &result {
        Ok(()) => {
            let _ = record_release(root, &version, &config);
            false
        }
        Err(_) => rollback(root, &version, &runner),
    };

    match result {
        Ok(()) => (
            true,
            false,
            format!("部署完成，当前版本 {version}"),
        ),
        Err(error) => (
            false,
            rolled_back,
            if rolled_back {
                format!("部署失败：{error}；已回退 current 标记，本机运行态未自动恢复")
            } else {
                format!("部署失败：{error}")
            },
        ),
    }
}

/// 五阶段。任一阶段失败即返回 Err，由上层决定回滚。
fn run_stages(runner: &Runner, config: &CicdConfig) -> Result<(), String> {
    // Preflight：工作目录存在 + 至少要有一条可执行命令
    runner.stage_start(STAGE_PREFLIGHT, "校验工作目录与配置");
    let started = Instant::now();
    if !runner.workdir.is_dir() {
        let ms = started.elapsed().as_millis() as u64;
        runner.stage_end(STAGE_PREFLIGHT, false, -1, ms);
        return Err(format!("工作目录不存在: {}", runner.workdir.display()));
    }
    if config.install.trim().is_empty()
        && config.build.trim().is_empty()
        && config.deploy.start.trim().is_empty()
        && config.deploy.install.trim().is_empty()
    {
        let ms = started.elapsed().as_millis() as u64;
        runner.stage_end(STAGE_PREFLIGHT, false, -1, ms);
        return Err(format!("{CONFIG_FILE} 里没有可执行的阶段命令"));
    }
    let ms = started.elapsed().as_millis() as u64;
    runner.stage_end(STAGE_PREFLIGHT, true, 0, ms);

    // Build：clean → install → build
    if !config.clean.trim().is_empty() {
        expect_ok(runner.run_command(STAGE_BUILD, &config.clean)?)?;
    }
    if !config.install.trim().is_empty() {
        expect_ok(runner.run_command(STAGE_BUILD, &config.install)?)?;
    }
    if !config.build.trim().is_empty() {
        expect_ok(runner.run_command(STAGE_BUILD, &config.build)?)?;
    }

    // Deploy：桌面应用走静默安装；服务型走停旧 + 后台起新
    if !config.deploy.install.trim().is_empty() {
        for name in config
            .deploy
            .install_kill
            .split(',')
            .map(str::trim)
            .filter(|name| !name.is_empty())
        {
            runner.push_log(format!("[deploy] 关闭进程 {name}"));
            let kill = if cfg!(windows) {
                format!("taskkill /IM {name} /F")
            } else {
                format!("pkill -f {name}")
            };
            // 进程不存在时 taskkill 会返回非 0，这里不算失败
            let _ = runner.run_command(STAGE_DEPLOY, &kill);
        }
        expect_ok(runner.run_command(STAGE_DEPLOY, &config.deploy.install)?)?;
    } else if !config.deploy.start.trim().is_empty() {
        if !config.deploy.stop.trim().is_empty() {
            let _ = runner.run_command(STAGE_DEPLOY, &config.deploy.stop);
        }
        runner.spawn_background(STAGE_DEPLOY, &config.deploy.start)?;
    }

    // Verify：url 探端口 或 自定义命令
    if !config.verify.command.trim().is_empty() {
        expect_ok(runner.run_command(STAGE_VERIFY, &config.verify.command)?)?;
    } else if !config.verify.url.trim().is_empty() {
        let timeout = config.verify.timeout.unwrap_or(DEFAULT_READY_TIMEOUT);
        runner.wait_for_port(STAGE_VERIFY, config.verify.url.trim(), timeout)?;
    }

    Ok(())
}

/// 把非 0 退出码变成错误
fn expect_ok(code: i32) -> Result<(), String> {
    if code == 0 {
        Ok(())
    } else {
        Err(format!("命令退出码 {code}"))
    }
}

/// 部署成功后：写 `releases/<version>/meta.json`、更新 `current`，并按 `keep_releases` 清理旧版本
fn record_release(root: &Path, version: &str, config: &CicdConfig) -> std::io::Result<()> {
    let releases = state_dir(root).join("releases");
    let dir = releases.join(version);
    std::fs::create_dir_all(&dir)?;
    let meta = serde_json::json!({
        "version": version,
        "time": now_secs(),
        "build": config.build,
        "deploy": {
            "start": config.deploy.start,
            "install": config.deploy.install,
        },
        "verify": {
            "url": config.verify.url,
            "command": config.verify.command,
        },
    });
    std::fs::write(
        dir.join("meta.json"),
        serde_json::to_string_pretty(&meta).unwrap_or_default(),
    )?;
    std::fs::write(state_dir(root).join("current"), version)?;
    prune_releases(&releases, config.keep_releases.unwrap_or(3));
    Ok(())
}

/// 只保留最近 N 个版本目录（按目录 mtime 从新到旧）
fn prune_releases(releases: &Path, keep: u32) {
    let Ok(entries) = std::fs::read_dir(releases) else {
        return;
    };
    let mut versions: Vec<(SystemTime, PathBuf)> = entries
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| {
            let meta = entry.metadata().ok()?;
            Some((meta.modified().ok()?, entry.path()))
        })
        .collect();
    versions.sort_by_key(|item| std::cmp::Reverse(item.0));
    for (_, path) in versions.into_iter().skip(keep.max(1) as usize) {
        let _ = std::fs::remove_dir_all(path);
    }
}

/// 失败回滚：把 `current` 指回上一个可用版本（存在则改，不存在则报告「无可回滚版本」）。
/// 本机运行态不做自动恢复——那依赖具体项目的部署方式，避免猜错造成二次破坏。
fn rollback(root: &Path, failed_version: &str, runner: &Runner) -> bool {
    runner.stage_start(STAGE_ROLLBACK, "查找上一个可用版本");
    let started = Instant::now();
    let releases = state_dir(root).join("releases");
    let previous = previous_release(&releases, failed_version);
    let Some(previous) = previous else {
        let ms = started.elapsed().as_millis() as u64;
        runner.stage_end(STAGE_ROLLBACK, false, -1, ms);
        return false;
    };
    let ok = std::fs::write(state_dir(root).join("current"), &previous).is_ok();
    let ms = started.elapsed().as_millis() as u64;
    runner.stage_end(STAGE_ROLLBACK, ok, if ok { 0 } else { -1 }, ms);
    if ok {
        runner.push_log(format!("[rollback] current 回退到 {previous}"));
    }
    ok
}

/// 找出比 `failed_version` 更早的最近一个版本目录名
fn previous_release(releases: &Path, failed_version: &str) -> Option<String> {
    let entries = std::fs::read_dir(releases).ok()?;
    let mut versions: Vec<(SystemTime, String)> = entries
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .filter(|entry| entry.file_name().to_string_lossy() != failed_version)
        .filter_map(|entry| {
            let meta = entry.metadata().ok()?;
            Some((meta.modified().ok()?, entry.file_name().to_string_lossy().into_owned()))
        })
        .collect();
    versions.sort_by_key(|item| std::cmp::Reverse(item.0));
    versions.into_iter().next().map(|(_, name)| name)
}

/// 把本次运行的日志写进 `.local-cicd/log/<version>.log`
fn write_run_log(root: &Path, version: &str, log: &Arc<Mutex<Vec<String>>>) -> std::io::Result<()> {
    let dir = state_dir(root).join("log");
    std::fs::create_dir_all(&dir)?;
    let lines = log.lock().map(|log| log.join("\n")).unwrap_or_default();
    std::fs::write(dir.join(format!("{version}.log")), lines)
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ---------- Tauri 命令 ----------

#[tauri::command]
pub fn cicd_read_config(
    fs: tauri::State<'_, crate::fs_api::FsState>,
    root: String,
) -> Result<ConfigFile, String> {
    let root = fs.checked_root(&root)?;
    let path = config_path(&root);
    let exists = path.is_file();
    let yaml = if exists {
        std::fs::read_to_string(&path).map_err(|e| format!("读取 {CONFIG_FILE} 失败: {e}"))?
    } else {
        String::new()
    };
    Ok(ConfigFile {
        path: path.to_string_lossy().into_owned(),
        exists,
        yaml,
    })
}

#[tauri::command]
pub fn cicd_write_config(
    fs: tauri::State<'_, crate::fs_api::FsState>,
    root: String,
    yaml: String,
) -> Result<(), String> {
    let root = fs.checked_root(&root)?;
    // 写前校验：必须能解析成配置，避免把面板写坏
    if !yaml.trim().is_empty() {
        serde_yaml::from_str::<CicdConfig>(&yaml).map_err(|e| format!("YAML 解析失败: {e}"))?;
    }
    std::fs::write(config_path(&root), yaml).map_err(|e| format!("写入 {CONFIG_FILE} 失败: {e}"))
}

#[tauri::command]
pub fn cicd_detect_config(
    fs: tauri::State<'_, crate::fs_api::FsState>,
    root: String,
) -> Result<String, String> {
    let root = fs.checked_root(&root)?;
    Ok(suggest_config_yaml(&root))
}

#[tauri::command]
pub fn cicd_run(
    state: tauri::State<'_, CicdState>,
    fs: tauri::State<'_, crate::fs_api::FsState>,
    root: String,
    on_event: Channel<CicdEvent>,
) -> Result<(), String> {
    let root = fs.checked_root(&root)?;
    let key = root.to_string_lossy().into_owned();

    {
        let runs = state.runs.lock().map_err(|e| e.to_string())?;
        if runs.contains_key(&key) {
            return Err("已有一条流水线在跑".into());
        }
    }

    let handle = Arc::new(RunHandle::new());
    {
        let mut runs = state.runs.lock().map_err(|e| e.to_string())?;
        runs.insert(key.clone(), Arc::clone(&handle));
    }

    let runs = Arc::clone(&state.runs);
    let key_for_thread = key.clone();
    std::thread::spawn(move || {
        let (ok, rolled_back, message) = execute_pipeline(&root, &handle, &on_event);
        let _ = on_event.send(CicdEvent::Finished {
            ok,
            rolled_back,
            message,
        });
        if let Ok(mut map) = runs.lock() {
            map.remove(&key_for_thread);
        }
    });

    Ok(())
}

#[tauri::command]
pub fn cicd_stop(
    state: tauri::State<'_, CicdState>,
    fs: tauri::State<'_, crate::fs_api::FsState>,
    root: String,
) -> Result<(), String> {
    let root = fs.checked_root(&root)?;
    let key = root.to_string_lossy().into_owned();
    let handle = {
        let runs = state.runs.lock().map_err(|e| e.to_string())?;
        runs.get(&key).cloned()
    };
    if let Some(handle) = handle {
        handle.cancel();
    }
    Ok(())
}

#[tauri::command]
pub fn cicd_status(
    state: tauri::State<'_, CicdState>,
    fs: tauri::State<'_, crate::fs_api::FsState>,
    root: String,
) -> Result<CicdStatus, String> {
    let root = fs.checked_root(&root)?;
    let key = root.to_string_lossy().into_owned();
    let running = state
        .runs
        .lock()
        .map_err(|e| e.to_string())?
        .contains_key(&key);
    Ok(CicdStatus {
        running,
        current_version: read_current(&root),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_minimal_config() {
        let config: CicdConfig = serde_yaml::from_str(
            "version: 1\ninstall: \"npm ci\"\nbuild: \"npm run build\"\ndeploy:\n  start: \"npm start\"\n  ready_timeout: 20\nverify:\n  url: \"http://127.0.0.1:8080/health\"\n",
        )
        .expect("解析失败");
        assert_eq!(config.install, "npm ci");
        assert_eq!(config.deploy.start, "npm start");
        assert_eq!(config.deploy.ready_timeout, Some(20));
        assert_eq!(config.verify.url, "http://127.0.0.1:8080/health");
    }

    #[test]
    fn env_values_are_stringified() {
        let config: CicdConfig =
            serde_yaml::from_str("env:\n  PORT: 8080\n  DEBUG: true\n").expect("解析失败");
        let env = config.env_strings();
        assert_eq!(env.get("PORT").map(String::as_str), Some("8080"));
        assert_eq!(env.get("DEBUG").map(String::as_str), Some("true"));
    }

    #[test]
    fn resolves_url_to_addr() {
        assert_eq!(
            url_to_addr("http://127.0.0.1:8080/health").as_deref(),
            Some("127.0.0.1:8080")
        );
        assert_eq!(
            url_to_addr("http://localhost/").as_deref(),
            Some("localhost:80")
        );
        assert_eq!(
            url_to_addr("https://example.com").as_deref(),
            Some("example.com:443")
        );
    }

    #[test]
    fn detects_node_project() {
        let dir = std::env::temp_dir().join(format!("cicd-detect-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join("package.json"), "{}").unwrap();
        std::fs::write(dir.join("pnpm-lock.yaml"), "").unwrap();
        let yaml = suggest_config_yaml(&dir);
        assert!(yaml.contains("pnpm"), "应识别出 pnpm: {yaml}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
