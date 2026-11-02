//! 启动外部命令行工具：跨三端最容易踩空的一块。
//!
//! 这里原本长在 `agent.rs` 里（给 opencode 子进程用）。切 Rig 之后没有 opencode 子进程了，
//! 但终端里的 AI CLI（`cli_sessions`）、意见反馈的 GitHub CLI（`feedback`）、
//! CICD 的构建命令（`cicd`）都还要用这套解析，所以单独成模块。

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Command;

/// 怎么把外部命令真正拉起来。
pub(crate) enum Launch {
    /// 直接执行
    Direct(PathBuf),
    /// Windows 上 npm 装出来的是 .cmd 垫片，CreateProcess 不认，得借 cmd 起
    ViaCmd(PathBuf),
}

/// 把配置里的「命令名」解析成一个能 spawn 的目标。
///
/// 收的是**单个可执行文件名或路径**，不是整条命令行：`npx foo` 那种得先拆开
/// （cli_sessions 的 `split_command` 就是干这个的）。
pub(crate) fn resolve_launch(configured: &str, path: Option<&OsStr>) -> Result<Launch, String> {
    let trimmed = configured.trim();
    if trimmed.is_empty() {
        return Err("没有配置可执行文件".to_string());
    }

    let found = if trimmed.contains('/') || trimmed.contains('\\') {
        let path = PathBuf::from(trimmed);
        if !path.is_file() {
            return Err(format!("找不到可执行文件：{trimmed}"));
        }
        path
    } else {
        find_on_path(trimmed, path)
            .ok_or_else(|| format!("在 PATH 里找不到 {trimmed}，请先安装或填写完整路径"))?
    };

    Ok(if needs_cmd_wrapper(&found) {
        Launch::ViaCmd(found)
    } else {
        Launch::Direct(found)
    })
}

/// Windows 上找可执行文件得挨个试后缀：npm 全局装出来的只有 `.cmd` 和无扩展名的
/// shell 脚本，没有 `.exe`，而 `CreateProcess` 只会自动补 `.exe`。
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

/// 用 cmd.exe 起一个垫片脚本。参数走 argv 之外的拼接，只用于没有空格的简单命令。
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

/// Windows 上不隐藏的话，每次起命令都会闪一个控制台黑框
#[cfg(windows)]
pub(crate) fn hide_console(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
pub(crate) fn hide_console(_command: &mut Command) {}

// ---- 子进程日志与收尾 ----

/// 子进程输出的环形缓冲。启动失败时靠它把原因带回给用户（预览面板也用它存日志）。
pub(crate) type ChildLog = std::sync::Arc<std::sync::Mutex<std::collections::VecDeque<String>>>;

/// 留多少行子进程输出。够看清启动失败的原因，又不会把整份日志堆在内存里。
pub(crate) const CHILD_LOG_LINES: usize = 40;

/// 把子进程的一路输出读进环形缓冲。读完即止，线程自己退出。
pub(crate) fn pump_child_log(stream: impl std::io::Read + Send + 'static, log: ChildLog) {
    use std::io::{BufRead, BufReader};
    std::thread::spawn(move || {
        for line in BufReader::new(stream).lines().map_while(Result::ok) {
            let Ok(mut buffer) = log.lock() else { return };
            if buffer.len() == CHILD_LOG_LINES {
                buffer.pop_front();
            }
            buffer.push_back(line);
        }
    });
}

#[cfg(windows)]
pub(crate) fn kill_child(child: &mut std::process::Child) {
    use std::process::{Command, Stdio};
    // 子进程常会派生子 shell，child.kill() 只杀得掉直接子进程，
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
pub(crate) fn kill_child(child: &mut std::process::Child) {
    use std::process::{Command, Stdio};
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

/// 挑一个空闲端口：让系统分配，拿到号之后立刻放掉。
pub(crate) fn free_port() -> Result<u16, String> {
    let listener =
        std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("分配端口失败: {e}"))?;
    listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|e| format!("读取端口失败: {e}"))
}

