//! 本机开发依赖安装：只允许安装内置白名单，避免把任意 shell 文本交给子进程。
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
];

#[derive(serde::Serialize)]
pub struct InstallResult {
    pub ok: bool,
    pub message: String,
}

fn run(program: &str, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new(program);
    command
        .args(args)
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
        );
        #[cfg(target_os = "macos")]
        let result = run("brew", &["install", "node"]);
        #[cfg(all(unix, not(target_os = "macos")))]
        let result = install_node_linux();
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
    let output = run("npm", &["install", "--global", spec.package])?;
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
fn install_node_linux() -> Result<String, String> {
    if command_exists("apt-get") {
        return run(
            "sh",
            &[
                "-c",
                "sudo apt-get update && sudo apt-get install -y nodejs npm",
            ],
        );
    }
    if command_exists("dnf") {
        return run("sudo", &["dnf", "install", "-y", "nodejs", "npm"]);
    }
    if command_exists("pacman") {
        return run("sudo", &["pacman", "-Sy", "--noconfirm", "nodejs", "npm"]);
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
