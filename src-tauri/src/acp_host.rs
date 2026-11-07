//! Windows ACP 子进程宿主。
//!
//! ACP SDK 负责启动和结束这个宿主；真实 CLI 由宿主放进 Windows Job Object，
//! 因此即使 SDK 直接结束宿主，Job Object 关闭时也会回收整棵进程树。

use std::ffi::OsString;
use std::io;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use process_wrap::tokio::{CommandWrap, CreationFlags, JobObject, KillOnDrop};
use tokio::io::{copy, stderr, stdin, stdout, AsyncWriteExt};
use tokio::process::Command as TokioCommand;
use tokio::task::JoinHandle;
use windows::Win32::System::Threading::CREATE_NO_WINDOW;

pub(crate) fn run(args: Vec<OsString>) -> i32 {
    match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => match runtime.block_on(run_inner(args)) {
            Ok(code) => code,
            Err(error) => {
                eprintln!("Codovo ACP host: {error}");
                1
            }
        },
        Err(error) => {
            eprintln!("Codovo ACP host runtime: {error}");
            1
        }
    }
}

async fn run_inner(args: Vec<OsString>) -> io::Result<i32> {
    let mut args = args.into_iter();
    let cwd = PathBuf::from(args.next().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "missing ACP working directory")
    })?);
    let program =
        PathBuf::from(args.next().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "missing ACP executable")
        })?);
    let cli_args: Vec<String> = args.map(|arg| arg.to_string_lossy().into_owned()).collect();

    let mut command = if crate::launch::needs_cmd_wrapper(&program) {
        crate::launch::wrap_with_cmd(
            &program,
            &cli_args.iter().map(String::as_str).collect::<Vec<_>>(),
        )
    } else {
        let mut command = Command::new(&program);
        command.args(&cli_args);
        command
    };
    command
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut command = CommandWrap::from(TokioCommand::from(command));
    // JobObject suspends the process until it is assigned, so a .cmd shim cannot
    // race ahead and start Node outside the job.
    command
        .wrap(CreationFlags(CREATE_NO_WINDOW))
        .wrap(KillOnDrop)
        .wrap(JobObject);
    let mut child = command.spawn()?;
    let child_stdin = child
        .stdin()
        .take()
        .ok_or_else(|| io::Error::other("ACP child stdin was not piped"))?;
    let child_stdout = child
        .stdout()
        .take()
        .ok_or_else(|| io::Error::other("ACP child stdout was not piped"))?;
    let child_stderr = child
        .stderr()
        .take()
        .ok_or_else(|| io::Error::other("ACP child stderr was not piped"))?;

    let mut input_task = tokio::spawn(async move {
        let mut child_stdin = child_stdin;
        let result = copy(&mut stdin(), &mut child_stdin).await;
        let _ = child_stdin.shutdown().await;
        result
    });
    let output_task = forward(child_stdout, stdout());
    let error_task = forward(child_stderr, stderr());

    // EOF on the ACP connection means the SDK is shutting down. Stop the whole
    // CLI job even if the CLI ignores stdin EOF or its wrapper has already exited.
    let status = tokio::select! {
        status = child.wait() => {
            input_task.abort();
            status?
        }
        input = &mut input_task => {
            if let Ok(Err(error)) = input {
                let _ = child.start_kill();
                let _ = child.wait().await;
                return Err(error);
            }
            child.start_kill()?;
            child.wait().await?
        }
    };

    // Also remove descendants left behind by a wrapper that exited on its own.
    let _ = child.start_kill();
    let _ = output_task.await;
    let _ = error_task.await;
    Ok(status.code().unwrap_or(1))
}

fn forward<R, W>(mut reader: R, mut writer: W) -> JoinHandle<io::Result<u64>>
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
    W: tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let copied = copy(&mut reader, &mut writer).await?;
        writer.shutdown().await?;
        Ok(copied)
    })
}
