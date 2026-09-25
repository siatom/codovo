use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const PATH_START: &[u8] = b"__CODEDOCK_PATH_START__";
const PATH_END: &[u8] = b"__CODEDOCK_PATH_END__";
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_PROBE_OUTPUT: u64 = 64 * 1024;

pub(crate) fn default_shell() -> String {
    #[cfg(windows)]
    {
        std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string())
    }

    #[cfg(target_os = "macos")]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
}

/// macOS 的 GUI 应用没有终端父进程，只能借 login shell 读取用户自己维护的 Node PATH。
pub(crate) fn login_args(shell: &str) -> Vec<String> {
    #[cfg(target_os = "macos")]
    if supports_login_shell(shell) {
        return vec!["-il".to_string()];
    }

    Vec::new()
}

/// 返回与终端一致的 PATH；探测失败时必须保留应用原本的环境，不能阻断终端启动。
pub(crate) fn resolved_path(shell: &str, cwd: Option<&Path>) -> Option<OsString> {
    let inherited = std::env::var_os("PATH");

    #[cfg(target_os = "macos")]
    {
        if supports_login_shell(shell) {
            probe_path(shell, cwd).or(inherited)
        } else {
            inherited
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (shell, cwd);
        inherited
    }
}

#[cfg(target_os = "macos")]
fn supports_login_shell(shell: &str) -> bool {
    matches!(
        Path::new(shell).file_name().and_then(OsStr::to_str),
        Some("zsh") | Some("bash") | Some("sh") | Some("ksh")
    )
}

#[cfg(target_os = "macos")]
fn probe_path(shell: &str, cwd: Option<&Path>) -> Option<OsString> {
    let script = "printf '__CODEDOCK_PATH_START__%s__CODEDOCK_PATH_END__\\n' \"$PATH\"";
    let mut command = Command::new(shell);
    command
        .args(["-ilc", script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(dir) = cwd {
        command.current_dir(dir);
    }

    let mut child = command.spawn().ok()?;
    let stdout = child.stdout.take();
    let reader = std::thread::spawn(move || {
        let mut output = Vec::new();
        if let Some(stdout) = stdout {
            let _ = stdout.take(MAX_PROBE_OUTPUT + 1).read_to_end(&mut output);
        }
        output
    });

    let deadline = Instant::now() + PROBE_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(10));
            }
            Ok(None) => {
                let _ = child.kill();
                break child.wait().ok()?;
            }
            Err(_) => return None,
        }
    };
    let output = reader.join().ok()?;

    if !status.success() || output.len() > MAX_PROBE_OUTPUT as usize {
        return None;
    }
    extract_path(&output)
}

#[cfg(target_os = "macos")]
fn extract_path(output: &[u8]) -> Option<OsString> {
    let start = output
        .windows(PATH_START.len())
        .rposition(|window| window == PATH_START)?
        + PATH_START.len();
    let end = output[start..]
        .windows(PATH_END.len())
        .position(|window| window == PATH_END)?
        + start;
    if start >= end {
        return None;
    }

    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStringExt;
        Some(OsString::from_vec(output[start..end].to_vec()))
    }

    #[cfg(not(unix))]
    {
        String::from_utf8(output[start..end].to_vec())
            .ok()
            .map(OsString::from)
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn extracts_path_after_shell_output() {
        let output = b"plugin output\n__CODEDOCK_PATH_START__/one:/two__CODEDOCK_PATH_END__\n";
        assert_eq!(extract_path(output), Some(OsString::from("/one:/two")));
    }

    #[test]
    fn uses_last_complete_marker_pair() {
        let output = b"__CODEDOCK_PATH_START__/old__CODEDOCK_PATH_END__\n__CODEDOCK_PATH_START__/new__CODEDOCK_PATH_END__";
        assert_eq!(extract_path(output), Some(OsString::from("/new")));
    }

    #[test]
    fn rejects_missing_or_empty_path() {
        assert_eq!(extract_path(b"__CODEDOCK_PATH_START__/one"), None);
        assert_eq!(
            extract_path(b"__CODEDOCK_PATH_START____CODEDOCK_PATH_END__"),
            None
        );
    }
}
