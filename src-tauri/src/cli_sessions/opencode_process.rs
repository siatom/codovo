use std::io::{self, ErrorKind};
use std::process::{Command, Output, Stdio};
use std::time::Duration;

use process_wrap::tokio::{CommandWrap, KillOnDrop};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::time::timeout;

// 会话数已经由 CLI 限制；异常输出应终止查询，而不是无限增长或解析半截 JSON。
const STDOUT_LIMIT: usize = 2 * 1024 * 1024;
const STDERR_LIMIT: usize = 64 * 1024;
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(2);

async fn read_output(reader: impl AsyncRead + Unpin, limit: usize) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() > limit {
        return Err(io::Error::other(format!("查询输出超过 {limit} 字节")));
    }
    Ok(bytes)
}

pub(super) async fn capture(mut command: Command, deadline: Duration) -> io::Result<Output> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut command = CommandWrap::from(tokio::process::Command::from(command));
    command.wrap(KillOnDrop);
    #[cfg(unix)]
    command.wrap(process_wrap::tokio::ProcessGroup::leader());
    #[cfg(windows)]
    {
        use process_wrap::tokio::{CreationFlags, JobObject};
        use windows::Win32::System::Threading::CREATE_NO_WINDOW;
        // 先挂入 Job 再恢复执行，cmd/npx 即使立即派生子进程，也不会逃出回收范围。
        command
            .wrap(CreationFlags(CREATE_NO_WINDOW))
            .wrap(JobObject);
    }
    let mut child = command.spawn()?;
    let stdout = child.stdout().take().expect("查询 stdout 已设为 pipe");
    let stderr = child.stderr().take().expect("查询 stderr 已设为 pipe");
    let result = timeout(deadline, async {
        // 两路并发读，不创建应用自己的读线程。先读完再回收根进程，避免包装进程
        // 提前退出、后代仍占用管道时，丢失清理进程组所需的身份。
        let (stdout, stderr) = tokio::try_join!(
            read_output(stdout, STDOUT_LIMIT),
            read_output(stderr, STDERR_LIMIT),
        )?;
        let status = child.inner_mut().wait().await?;
        Ok(Output {
            status,
            stdout,
            stderr,
        })
    })
    .await;
    let error = match result {
        Ok(Ok(output)) => return Ok(output),
        Ok(Err(error)) => error,
        Err(_) => io::Error::new(
            ErrorKind::TimedOut,
            format!("opencode 超过 {} 秒没有响应", deadline.as_secs()),
        ),
    };
    // 超时或任一路输出异常时，先结束整组，再等根进程回收。即便整组清理失败，
    // 也尽力结束直接子进程；Windows Job 的最后一个句柄关闭时还会兜底回收。
    if let Err(kill_error) = child.start_kill() {
        let _ = child.inner_mut().start_kill();
        let _ = timeout(CLEANUP_TIMEOUT, child.inner_mut().wait()).await;
        return Err(io::Error::new(
            error.kind(),
            format!("{error}；清理查询进程组失败：{kill_error}"),
        ));
    }
    match timeout(CLEANUP_TIMEOUT, child.wait()).await {
        Ok(Ok(_)) => Err(error),
        Ok(Err(wait_error)) => Err(io::Error::new(
            error.kind(),
            format!("{error}；等待查询进程退出失败：{wait_error}"),
        )),
        Err(_) => Err(io::Error::new(
            error.kind(),
            format!("{error}；等待查询进程退出超时"),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;

    fn shell(script: &str) -> Command {
        #[cfg(unix)]
        {
            let mut command = Command::new("sh");
            command.args(["-c", script]);
            command
        }
        #[cfg(windows)]
        {
            let mut command = Command::new("powershell.exe");
            command.args(["-NoProfile", "-NonInteractive", "-Command", script]);
            command
        }
    }

    #[tokio::test]
    async fn captures_both_pipes_and_preserves_nonzero_status() {
        #[cfg(unix)]
        let script = "printf '[{\"id\":\"test\"}]'; printf 'diagnostic' >&2; exit 7";
        #[cfg(windows)]
        let script = "[Console]::Out.Write('[{\"id\":\"test\"}]'); [Console]::Error.Write('diagnostic'); exit 7";
        let output = capture(shell(script), Duration::from_secs(10))
            .await
            .unwrap();
        assert_eq!(output.stdout, b"[{\"id\":\"test\"}]");
        assert_eq!(output.stderr, b"diagnostic");
        assert_eq!(output.status.code(), Some(7));
    }

    #[tokio::test]
    async fn reads_both_pipes_without_deadlocking_and_rejects_unbounded_output() {
        // 每路均大于操作系统管道容量，串行读 stdout 再读 stderr 会卡住。
        #[cfg(unix)]
        let script = "i=0; while [ $i -lt 10000 ]; do printf '1234567890'; printf 'err' >&2; i=$((i+1)); done";
        #[cfg(windows)]
        let script = "for($i=0;$i -lt 10000;$i++){[Console]::Out.Write('1234567890');[Console]::Error.Write('err')}";
        let output = capture(shell(script), Duration::from_secs(15))
            .await
            .unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout.len(), 100000);
        assert_eq!(output.stderr.len(), 30000);
        for stderr in [false, true] {
            #[cfg(unix)]
            let script = if stderr {
                "while :; do printf 'overflow' >&2; done"
            } else {
                "while :; do printf 'overflow'; done"
            };
            #[cfg(windows)]
            let script = if stderr {
                "while($true){[Console]::Error.Write(('overflow'*1024))}"
            } else {
                "while($true){[Console]::Out.Write(('overflow'*1024))}"
            };
            let error = capture(shell(script), Duration::from_secs(15))
                .await
                .unwrap_err();
            assert_ne!(error.kind(), ErrorKind::TimedOut);
            assert!(error.to_string().contains("输出超过"), "{error}");
        }
    }

    #[cfg(unix)]
    async fn descendant_timeout(directory: &Path, parent_exits: bool) {
        let marker = directory.join("heartbeat");
        let script = format!(
            "(trap '' TERM; while :; do printf x >> \"$1\"; sleep 0.02; done) & {}",
            if parent_exits { "exit 0" } else { "wait" }
        );
        let mut command = shell(&script);
        command.arg("fake-opencode").arg(&marker);
        let started = std::time::Instant::now();
        let error = capture(command, Duration::from_millis(500))
            .await
            .unwrap_err();
        assert_eq!(error.kind(), ErrorKind::TimedOut, "{error}");
        assert!(started.elapsed() < Duration::from_secs(3));
        assert_stopped(&marker).await;
    }

    async fn assert_stopped(marker: &Path) {
        let before = fs::metadata(marker).expect("后代应在超时前已启动").len();
        assert!(before > 0);
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(
            fs::metadata(marker).unwrap().len(),
            before,
            "超时返回后子进程仍在运行"
        );
    }

    #[tokio::test]
    async fn repeated_queries_reclaim_descendants_even_after_wrapper_exits() {
        let directory = std::env::temp_dir().join(format!(
            "codovo-opencode-process-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&directory).unwrap();
        #[cfg(unix)]
        for parent_exits in [false, true, false, true] {
            let path = directory.join(format!("{parent_exits}"));
            fs::create_dir_all(&path).unwrap();
            // 每轮先清除旧标记，不把前一次查询的输出当成新进程已启动。
            let _ = fs::remove_file(path.join("heartbeat"));
            descendant_timeout(&path, parent_exits).await;
        }
        #[cfg(windows)]
        {
            // .cmd -> PowerShell 链，覆盖 npm/npx 垫片的启动形态。
            let script = directory.join("child.ps1");
            fs::write(&script, "while($true){[IO.File]::AppendAllText((Join-Path $PSScriptRoot 'heartbeat'),'x');Start-Sleep -Milliseconds 20}").unwrap();
            let wrapper = directory.join("opencode.cmd");
            for detached in [false, true, false] {
                let prefix = if detached { "start \"\" /b " } else { "" };
                fs::write(&wrapper, format!("@echo off\r\n{prefix}powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"%~dp0child.ps1\"\r\nexit /b 0\r\n")).unwrap();
                let _ = fs::remove_file(directory.join("heartbeat"));
                let command = crate::launch::wrap_with_cmd(&wrapper, &[]);
                let error = capture(command, Duration::from_secs(4)).await.unwrap_err();
                assert_eq!(error.kind(), ErrorKind::TimedOut, "{error}");
                assert_stopped(&directory.join("heartbeat")).await;
            }
        }
        #[cfg(unix)]
        {
            let first = directory.join("parallel-first");
            let second = directory.join("parallel-second");
            fs::create_dir_all(&first).unwrap();
            fs::create_dir_all(&second).unwrap();
            tokio::join!(
                descendant_timeout(&first, false),
                descendant_timeout(&second, true)
            );
        }
        fs::remove_dir_all(directory).unwrap();
    }
}
