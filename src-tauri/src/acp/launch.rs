//! 把「用户在设置里配的 AI CLI 命令」翻译成 ACP 子进程的启动配置。
//!
//! 终端那套命令是给人看的（`opencode`、`npx codebuddy`），ACP 要在后面接上各家的
//! 子命令/开关。这里只认明确支持 ACP 的几家；认不出来的返回错误，由前端把「这家
//! 还不能在对话里用」显示出来，而不是猜一个参数把它起崩。

use std::path::Path;

use agent_client_protocol::AcpAgentConfig;

use crate::launch::Launch;

/// 对话面板支持的 CLI。key 与 `src/lib/cli-sessions.ts` 的 `CliProvider.key` 对齐；
/// 加一家时两边一起改，并补上 `acp_args` / `plan`。
pub(crate) fn supported(provider: &str) -> bool {
    matches!(
        provider,
        "opencode" | "codebuddy" | "gemini" | "copilot" | "codex" | "claude" | "qoder"
    )
}

/// 各家 ACP 入口参数。
fn acp_args(provider: &str) -> Result<&'static [&'static str], String> {
    match provider {
        // opencode 用子命令
        "opencode" => Ok(&["acp"]),
        // 其余原生支持的走 --acp
        "codebuddy" | "gemini" | "copilot" | "qoder" => Ok(&["--acp"]),
        other => Err(format!("{other} 没有原生 ACP 入口")),
    }
}

/// provider → 实际要执行的程序与参数。
///
/// Codex / Claude Code 没有原生 ACP 入口，用官方适配器；`npx -y` 首次运行会下载，
/// 之后走 npm 缓存。适配器自带对应 CLI 依赖，不需要再把用户配的 codex/claude 传进去。
fn plan(provider: &str, command: &str) -> Result<(String, Vec<String>), String> {
    match provider {
        "codex" => Ok((
            "npx".to_string(),
            vec![
                "-y".to_string(),
                "@agentclientprotocol/codex-acp".to_string(),
            ],
        )),
        "claude" => Ok((
            "npx".to_string(),
            vec![
                "-y".to_string(),
                "@agentclientprotocol/claude-agent-acp".to_string(),
            ],
        )),
        _ => {
            let mut parts = command.split_whitespace();
            let program = parts.next().ok_or_else(|| "没有配置启动命令".to_string())?;
            let mut args: Vec<String> = parts.map(str::to_string).collect();
            args.extend(acp_args(provider)?.iter().map(|arg| (*arg).to_string()));
            Ok((program.to_string(), args))
        }
    }
}

/// 拼出 ACP 子进程的启动配置。
///
/// `command` 是设置里的整条命令（可能带用户自己的运行参数），`env` 是这条命令配的
/// 环境变量。命令按空白拆——和 `cli_sessions` / `preview` 的既有做法一致，不额外
/// 支持引号里的空格。
///
/// 子进程的工作目录必须显式设成会话的 cwd：ACP 的 `session/new` 只传协议字段，
/// SDK 启动进程时用的是应用自己的 cwd。opencode 会按协议用 session cwd，但
/// CodeBuddy 这类 CLI 会拿进程 cwd 当工作目录（实测会写到 `src-tauri/` 下）。
pub(crate) fn agent_config(
    provider: &str,
    command: &str,
    env: &[(String, String)],
    cwd: &Path,
) -> Result<AcpAgentConfig, String> {
    let (program, args) = plan(provider, command)?;

    let path = std::env::var_os("PATH");
    let executable = match crate::launch::resolve_launch(&program, path.as_deref())? {
        Launch::Direct(path) | Launch::ViaCmd(path) => path,
    };

    #[cfg(windows)]
    let config = {
        // 一律借 cmd 起：既为了 .cmd 垫片（CreateProcess 不认），也为了先 cd 到会话目录。
        // 不加 /S：路径带空格时 Command 会给参数加引号，cmd 在「引号里是可执行文件」
        // 时会保留引号；/S 会把引号剥掉，反而拆坏路径。
        AcpAgentConfig::new("cmd")
            .arg("/C")
            .arg("cd")
            .arg("/D")
            .arg(cwd.display().to_string())
            .arg("&&")
            .arg(executable.display().to_string())
            .args(args)
    };
    #[cfg(not(windows))]
    let config = {
        // sh 用 exec 换成目标进程，SDK 按进程组回收时不会多留一层 shell
        AcpAgentConfig::new("sh")
            .arg("-c")
            .arg("cd \"$1\" && shift && exec \"$@\"")
            .arg("codovo-acp")
            .arg(cwd.display().to_string())
            .arg(executable.display().to_string())
            .args(args)
    };

    Ok(config.envs(env.iter().cloned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_provider_is_rejected() {
        assert!(agent_config("qwen", "qwen", &[], &std::env::temp_dir()).is_err());
    }

    #[test]
    fn opencode_gets_acp_subcommand() {
        assert_eq!(acp_args("opencode").unwrap(), ["acp"]);
    }

    #[test]
    fn codebuddy_gets_acp_flag() {
        assert_eq!(acp_args("codebuddy").unwrap(), ["--acp"]);
    }

    #[test]
    fn qoder_gets_acp_flag() {
        assert!(supported("qoder"));
        assert_eq!(acp_args("qoder").unwrap(), ["--acp"]);
        assert_eq!(
            plan("qoder", "qodercli").unwrap(),
            ("qodercli".to_string(), vec!["--acp".to_string()])
        );
    }

    #[test]
    fn codex_uses_official_adapter() {
        let (program, args) = plan("codex", "codex --no-daemon").unwrap();
        assert_eq!(program, "npx");
        assert_eq!(args, ["-y", "@agentclientprotocol/codex-acp"]);
    }

    #[test]
    fn claude_uses_official_adapter() {
        let (program, args) = plan("claude", "claude").unwrap();
        assert_eq!(program, "npx");
        assert_eq!(args, ["-y", "@agentclientprotocol/claude-agent-acp"]);
    }

    /// Windows 上 .cmd 垫片的路径带空格时，`cmd /C <path> args` 也要能跑。
    /// 这里直接走 std::process::Command，验证的是我们交给 AcpAgentConfig 的形状。
    #[cfg(windows)]
    #[test]
    fn cmd_shim_path_with_spaces() {
        let dir = std::env::temp_dir().join("codovo acp shim test single");
        std::fs::create_dir_all(&dir).unwrap();
        let shim = dir.join("echo-args.cmd");
        std::fs::write(&shim, "@echo %1 %2\r\n").unwrap();

        let output = std::process::Command::new("cmd")
            .arg("/C")
            .arg(shim.display().to_string())
            .arg("hello")
            .arg("world")
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        let _ = std::fs::remove_dir_all(&dir);
        assert!(stdout.contains("hello world"), "stdout: {stdout}");
    }

    /// 启动前先 `cd` 到会话目录时，命令里会同时出现两个带空格的路径。
    /// 这条用例确认 cmd 仍能正确解析（引号不能被 /C 剥坏）。
    #[cfg(windows)]
    #[test]
    fn cmd_chain_with_spaces() {
        let dir = std::env::temp_dir().join("codovo acp shim test chain");
        std::fs::create_dir_all(&dir).unwrap();
        let shim = dir.join("echo-args.cmd");
        std::fs::write(&shim, "@cd\r\n@echo %1 %2\r\n").unwrap();

        let output = std::process::Command::new("cmd")
            .arg("/C")
            .arg("cd")
            .arg("/D")
            .arg(dir.display().to_string())
            .arg("&&")
            .arg(shim.display().to_string())
            .arg("hello")
            .arg("world")
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        let _ = std::fs::remove_dir_all(&dir);
        assert!(stdout.contains("hello world"), "stdout: {stdout}");
    }
}
