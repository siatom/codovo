//! 本机开发依赖安装：只允许安装内置白名单，避免把任意 shell 文本交给子进程。
use std::ffi::OsStr;
use std::process::{Command, Stdio};

#[derive(Clone, Copy)]
struct PackageSpec {
    id: &'static str,
    label: &'static str,
    package: &'static str,
}

const NPM_PACKAGES: &[PackageSpec] = &[
    PackageSpec {
        id: "opencode",
        label: "opencode",
        package: "@opencode/cli",
    },
    PackageSpec {
        id: "codex",
        label: "Codex",
        package: "@openai/codex",
    },
    PackageSpec {
        id: "codebuddy",
        label: "CodeBuddy",
        package: "@tencent-ai/codebuddy-code",
    },
    PackageSpec {
        id: "claude",
        label: "Claude Code",
        package: "@anthropic-ai/claude-code",
    },
    PackageSpec {
        id: "gitee",
        label: "Gitee CLI",
        package: "@gitee/gitee-cli",
    },
];

#[derive(serde::Serialize)]
pub struct InstallResult {
    pub ok: bool,
    pub message: String,
}

#[derive(serde::Serialize)]
pub struct DependencyStatus {
    pub id: String,
    pub installed: bool,
    pub version: Option<String>,
}

fn executable_for(id: &str) -> Option<&'static str> {
    match id {
        "node" => Some("node"),
        "git" => Some("git"),
        "gitee" => Some("gitee"),
        "opencode" => Some("opencode"),
        "codex" => Some("codex"),
        "codebuddy" => Some("codebuddy"),
        "claude" => Some("claude"),
        _ => None,
    }
}

#[tauri::command]
pub async fn check_dependencies() -> Result<Vec<DependencyStatus>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        // PATH 必须和 agent 起 opencode 时用的一致：macOS 的 GUI 进程没有终端父进程，
        // 直接读进程环境拿不到用户装 Node 的那串路径，装了也会被全判成未安装。
        let path = crate::shell_env::resolved_path(&crate::shell_env::default_shell(), None);
        let path = path.as_deref();
        [
            "git",
            "node",
            "opencode",
            "codex",
            "codebuddy",
            "claude",
            "gitee",
        ]
        .into_iter()
        .map(|id| {
            let version = executable_for(id)
                .and_then(|program| run(program, &["--version"], path).ok())
                .filter(|value| !value.trim().is_empty());
            DependencyStatus {
                id: id.to_string(),
                installed: version.is_some(),
                version,
            }
        })
        .collect()
    })
    .await
    .map_err(|error| format!("检查依赖失败：{error}"))
}

/// 起一个外部命令并收下它的输出。`path` 为 None 时退回进程自身的环境变量。
///
/// 这里必须自己解析可执行文件，不能直接 `Command::new("opencode")`：Windows 上
/// npm 全局装出来的 CLI 只有 `.cmd` 垫片和无扩展名的 sh 脚本，没有 `.exe`，而
/// `CreateProcess` 只会自动补 `.exe`——直接起必然失败，依赖面板就会把装好的东西
/// 全报成未安装（opencode / codex / codebuddy / claude / gitee 都是这种）。
/// 后缀探测与 `cmd /c` 包装复用 agent 那套，三端差异只留一份。
fn run(program: &str, args: &[&str], path: Option<&OsStr>) -> Result<String, String> {
    let inherited;
    let path = match path {
        Some(path) => Some(path),
        None => {
            inherited = std::env::var_os("PATH");
            inherited.as_deref()
        }
    };

    let mut command = match crate::agent::find_on_path(program, path) {
        Some(found) if crate::agent::needs_cmd_wrapper(&found) => {
            crate::agent::wrap_with_cmd(&found, args)
        }
        Some(found) => {
            let mut command = Command::new(found);
            command.args(args);
            command
        }
        // 找不到就原样交给系统：报错里带上原始命令名，比"找不到 X"更好定位
        None => {
            let mut command = Command::new(program);
            command.args(args);
            command
        }
    };
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut command);
    let output = command
        .output()
        .map_err(|error| format!("无法启动 {program}：{error}"))?;
    let mut text = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !stderr.trim().is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&stderr);
    }
    if output.status.success() {
        Ok(text.trim().to_string())
    } else {
        Err(format!(
            "{program} 退出码 {:?}：{}",
            output.status.code(),
            text.trim()
        ))
    }
}

#[tauri::command]
pub async fn install_dependency(id: String) -> Result<InstallResult, String> {
    tauri::async_runtime::spawn_blocking(move || install_dependency_sync(&id))
        .await
        .map_err(|error| format!("安装任务失败：{error}"))?
}

fn install_dependency_sync(id: &str) -> Result<InstallResult, String> {
    // 和检测同一套 PATH：npm / winget / brew 在 Windows 上也都是 `.cmd` 垫片，
    // 而且 macOS 的 GUI 进程得靠 login shell 才拿得到 brew 的路径
    let path = crate::shell_env::resolved_path(&crate::shell_env::default_shell(), None);
    let path = path.as_deref();

    if id == "git" {
        #[cfg(target_os = "windows")]
        let result = run(
            "winget",
            &[
                "install",
                "--id",
                "Git.Git",
                "--exact",
                "--accept-source-agreements",
                "--accept-package-agreements",
            ],
            path,
        );
        #[cfg(target_os = "macos")]
        let result = run("brew", &["install", "git"], path);
        #[cfg(all(unix, not(target_os = "macos")))]
        let result = install_git_linux(path);
        return result.map(|output| InstallResult {
            ok: true,
            message: if output.is_empty() {
                "Git 安装完成，请重启 CodeDock 使 PATH 生效。".into()
            } else {
                format!("Git 安装完成。\n{output}")
            },
        });
    }

    if id == "node" {
        #[cfg(target_os = "windows")]
        let result = run(
            "winget",
            &[
                "install",
                "--id",
                "OpenJS.NodeJS.LTS",
                "--exact",
                "--accept-source-agreements",
                "--accept-package-agreements",
            ],
            path,
        );
        #[cfg(target_os = "macos")]
        let result = run("brew", &["install", "node"], path);
        #[cfg(all(unix, not(target_os = "macos")))]
        let result = install_node_linux(path);
        return result.map(|output| InstallResult {
            ok: true,
            message: if output.is_empty() {
                "Node.js 安装完成，请重启 CodeDock 使 PATH 生效。".into()
            } else {
                format!("Node.js 安装完成。\n{output}")
            },
        });
    }

    let spec = NPM_PACKAGES
        .iter()
        .find(|item| item.id == id)
        .ok_or_else(|| "不支持的依赖项".to_string())?;
    let output = run("npm", &["install", "--global", spec.package], path)?;
    Ok(InstallResult {
        ok: true,
        message: if output.is_empty() {
            format!("{} 安装完成。", spec.label)
        } else {
            format!("{} 安装完成。\n{output}", spec.label)
        },
    })
}

#[cfg(all(unix, not(target_os = "macos")))]
fn install_git_linux(path: Option<&OsStr>) -> Result<String, String> {
    if command_exists("apt-get") {
        return run(
            "sh",
            &["-c", "sudo apt-get update && sudo apt-get install -y git"],
            path,
        );
    }
    if command_exists("dnf") {
        return run("sudo", &["dnf", "install", "-y", "git"], path);
    }
    if command_exists("pacman") {
        return run("sudo", &["pacman", "-Sy", "--noconfirm", "git"], path);
    }
    Err("未找到 apt-get、dnf 或 pacman。请先安装 Git，或手动安装系统包。".into())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn install_node_linux(path: Option<&OsStr>) -> Result<String, String> {
    if command_exists("apt-get") {
        return run(
            "sh",
            &[
                "-c",
                "sudo apt-get update && sudo apt-get install -y nodejs npm",
            ],
            path,
        );
    }
    if command_exists("dnf") {
        return run("sudo", &["dnf", "install", "-y", "nodejs", "npm"], path);
    }
    if command_exists("pacman") {
        return run(
            "sudo",
            &["pacman", "-Sy", "--noconfirm", "nodejs", "npm"],
            path,
        );
    }
    Err("未找到 apt-get、dnf 或 pacman。请先安装系统包管理器，或手动安装 Node.js。".into())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn command_exists(program: &str) -> bool {
    Command::new("sh")
        .args(["-c", &format!("command -v {program}")])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn hide_console(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x08000000);
}
#[cfg(not(target_os = "windows"))]
fn hide_console(_command: &mut Command) {}
