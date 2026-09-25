// 平台层的统一入口：跨平台函数留在外层，macOS 的 login shell 探测实现全部收进
// 下面的 macos 子模块，只用一个 cfg 门控，省得每个 item 都挂一遍 #[cfg]。
use std::ffi::OsString;
use std::path::Path;

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
/// 调用方（pty.rs 的 default_shell）只在 unix 分支里用，Windows 下不需要这个函数。
#[cfg(unix)]
pub(crate) fn login_args(shell: &str) -> Vec<String> {
    #[cfg(target_os = "macos")]
    {
        if macos::supports_login_shell(shell) {
            return vec!["-il".to_string()];
        }
    }

    #[cfg(not(target_os = "macos"))]
    let _ = shell;
    Vec::new()
}

/// 返回与终端一致的 PATH；探测失败时必须保留应用原本的环境，不能阻断终端启动。
pub(crate) fn resolved_path(shell: &str, cwd: Option<&Path>) -> Option<OsString> {
    let inherited = std::env::var_os("PATH");

    #[cfg(target_os = "macos")]
    {
        if macos::supports_login_shell(shell) {
            macos::probe_path(shell, cwd).or(inherited)
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
mod macos {
    use std::ffi::{OsStr, OsString};
    use std::io::Read;
    // 模块本身就是 macOS(=unix)，extract_path 不必再区分 unix / 非 unix。
    use std::os::unix::ffi::OsStringExt;
    use std::path::Path;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    const PATH_START: &[u8] = b"__CODEDOCK_PATH_START__";
    const PATH_END: &[u8] = b"__CODEDOCK_PATH_END__";
    const PROBE_TIMEOUT: Duration = Duration::from_secs(2);
    const MAX_PROBE_OUTPUT: u64 = 64 * 1024;

    pub(super) fn supports_login_shell(shell: &str) -> bool {
        matches!(
            Path::new(shell).file_name().and_then(OsStr::to_str),
            Some("zsh") | Some("bash") | Some("sh") | Some("ksh")
        )
    }

    pub(super) fn probe_path(shell: &str, cwd: Option<&Path>) -> Option<OsString> {
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

        Some(OsString::from_vec(output[start..end].to_vec()))
    }

    #[cfg(test)]
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
}
