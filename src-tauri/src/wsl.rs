use std::process::Command;
use std::os::windows::process::CommandExt;

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WslDirectory {
    name: String,
    path: String,
}

fn wsl() -> Result<Command, String> {
    let mut command = Command::new("wsl.exe");
    command.creation_flags(0x08000000);
    Ok(command)
}

fn output(command: &mut Command) -> Result<Vec<u8>, String> {
    let result = command.output().map_err(|e| format!("无法启动 WSL：{e}"))?;
    if !result.status.success() {
        return Err(String::from_utf8_lossy(&result.stderr).trim().to_string());
    }
    Ok(result.stdout)
}

fn decode_wsl(bytes: &[u8]) -> String {
    // wsl.exe 的 --list 输出为 UTF-16LE，即使传了 --quiet。
    if bytes.starts_with(&[0xff, 0xfe]) || bytes.get(1) == Some(&0) {
        let start = usize::from(bytes.starts_with(&[0xff, 0xfe])) * 2;
        String::from_utf16_lossy(
            &bytes[start..]
                .chunks_exact(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect::<Vec<_>>(),
        )
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

#[tauri::command]
pub fn wsl_list_distributions() -> Result<Vec<String>, String> {
    let bytes = output(wsl()?.args(["--list", "--quiet"]))?;
    let distributions = decode_wsl(&bytes)
        .lines()
        .map(|line| line.trim().trim_start_matches('*').trim().to_string())
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    if distributions.is_empty() {
        return Err("未找到可用的 WSL 发行版，请先安装或启动一个发行版。".into());
    }
    Ok(distributions)
}

#[tauri::command]
pub fn wsl_list_directories(distribution: String, path: String) -> Result<Vec<WslDirectory>, String> {
    if distribution.is_empty() || distribution.contains(['\\', '/', '\0']) {
        return Err("WSL 发行版名称无效".into());
    }
    let path = if path.is_empty() { "/" } else { &path };
    if !path.starts_with('/') || path.contains('\0') {
        return Err("WSL 目录路径无效".into());
    }
    let bytes = output(wsl()?.args([
        "--distribution",
        &distribution,
        "--exec",
        "find",
        path,
        "-mindepth",
        "1",
        "-maxdepth",
        "1",
        "-type",
        "d",
        "-printf",
        "%f\\0",
    ]))?;
    let mut directories = String::from_utf8_lossy(&bytes)
        .split('\0')
        .filter(|entry| !entry.is_empty())
        .filter_map(|entry| {
            let prefix = format!("{}/", path.trim_end_matches('/'));
            let name = entry.strip_prefix(&prefix)?;
            if name.contains('/') {
                return None;
            }
            Some(WslDirectory {
                name: name.to_string(),
                path: entry.to_string(),
            })
        })
        .collect::<Vec<_>>();
    directories.sort_by_key(|item| item.name.to_lowercase());
    Ok(directories)
}
