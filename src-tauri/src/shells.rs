// 终端可选的 shell：探测本机真实存在的候选，并把「用户选中的 id」解析成
// 「程序 + 启动参数」。各 shell 需要的参数差得很远（pwsh 要 -NoLogo、
// git-bash 不带 --login -i 就拿不到正常 PATH），所以参数跟着候选一起在这里定死，
// 不让它出现在设置界面上——用户只挑 shell。
use serde::Serialize;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellInfo {
    pub id: String,
    /// 设置下拉里的长名，如「PowerShell 7 (pwsh)」
    pub label: String,
    /// 终端标签页里的简洁名，如 pwsh / cmd / Git Bash / zsh
    pub name: String,
    /// 挑图标用的键：pwsh / powershell / cmd / git-bash / wsl / zsh / bash / fish / nushell，
    /// 认不出的 shell 一律是 shell（前端落到单色终端图标）
    pub kind: String,
}

/// 候选的内部形态：给前端看的信息 + 真正拿去 spawn 的程序和参数。
struct Entry {
    info: ShellInfo,
    program: String,
    args: Vec<String>,
}

/// 候选表里逐条构造 `Entry` 的简写。只有 Windows 的 `table()` 用得上——
/// unix 的候选来自 /etc/shells，名字、图标、启动参数都得一个个现算。
#[cfg(windows)]
fn entry(id: &str, name: &str, kind: &str, label: &str, program: &str, args: &[&str]) -> Entry {
    Entry {
        info: ShellInfo {
            id: id.to_string(),
            label: label.to_string(),
            name: name.to_string(),
            kind: kind.to_string(),
        },
        program: program.to_string(),
        args: args.iter().map(|arg| arg.to_string()).collect(),
    }
}

/// 从可执行文件路径推 tab 上要显示的名字和图标键。auto 分支（以及 unix 候选）
/// 手上只有程序路径，所以只能按 basename 判断。
fn describe(program: &str) -> (String, String) {
    let base = std::path::Path::new(program)
        .file_name()
        .map(|name| name.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    let stem = base.strip_suffix(".exe").unwrap_or(&base);
    // 显示名就是可执行文件名；图标键另算——同族的 shell 共用一个 logo
    let kind = match stem {
        "pwsh" => "pwsh",
        "powershell" => "powershell",
        "cmd" => "cmd",
        "zsh" => "zsh",
        "fish" => "fish",
        "nu" => "nushell",
        // POSIX / bash 兼容（含 Debian 的 dash、BSD 的 ksh、busybox 的 ash）：
        // 这些都没有各自的 logo，共用 GNU Bash 那一个
        "bash" | "sh" | "dash" | "ksh" | "mksh" | "rbash" | "ash" => "bash",
        // C shell 家族同样没有 logo，落到通用命令行窗口图标
        "csh" | "tcsh" => "csh",
        _ => "shell",
    };
    (stem.to_string(), kind.to_string())
}

#[cfg(windows)]
fn on_path(name: &str) -> bool {
    match std::env::var_os("PATH") {
        Some(path) => std::env::split_paths(&path).any(|dir| dir.join(name).is_file()),
        None => false,
    }
}

/// 找 Git Bash 的 bash.exe。PATH 里的 bash.exe 也可能是 WSL 的入口
/// （System32\bash.exe），那个必须排除，否则会把它当成 Git Bash 起起来。
#[cfg(windows)]
fn find_git_bash() -> Option<std::path::PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).find_map(|dir| {
        let candidate = dir.join("bash.exe");
        if !candidate.is_file() {
            return None;
        }
        if dir.to_string_lossy().to_lowercase().ends_with("system32") {
            return None;
        }
        Some(candidate)
    })
}

#[cfg(windows)]
fn table() -> Vec<Entry> {
    let mut entries = Vec::new();
    if on_path("pwsh.exe") {
        entries.push(entry(
            "pwsh",
            "pwsh",
            "pwsh",
            "PowerShell 7 (pwsh)",
            "pwsh.exe",
            &["-NoLogo"],
        ));
    }
    if on_path("powershell.exe") {
        entries.push(entry(
            "powershell",
            "powershell",
            "powershell",
            "Windows PowerShell",
            "powershell.exe",
            &["-NoLogo"],
        ));
    }
    // cmd 几乎必然存在（ComSpec 兜底），不用探测，直接列
    let comspec = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string());
    entries.push(entry(
        "cmd",
        "cmd",
        "cmd",
        "命令提示符 (cmd)",
        &comspec,
        &[],
    ));
    if let Some(bash) = find_git_bash() {
        entries.push(entry(
            "git-bash",
            "Git Bash",
            "git-bash",
            "Git Bash",
            &bash.to_string_lossy(),
            &["--login", "-i"],
        ));
    }
    if on_path("wsl.exe") {
        entries.push(entry("wsl", "WSL", "wsl", "WSL", "wsl.exe", &[]));
    }
    entries
}

#[cfg(windows)]
fn auto_shell() -> (String, Vec<String>) {
    // 默认用 Git Bash：Windows 上跑 CLI 工具（各种 *nix 风格命令）最省事。
    // 直接复用候选表里那条，免得 program / 启动参数两处各写一份、将来改一处忘一处。
    if let Some(git_bash) = table().into_iter().find(|item| item.info.id == "git-bash") {
        return (git_bash.program, git_bash.args);
    }
    // 本机没装 Git Bash 才退回原来的顺序：pwsh → Windows PowerShell → ComSpec
    for candidate in ["pwsh.exe", "powershell.exe"] {
        if on_path(candidate) {
            return (candidate.to_string(), vec!["-NoLogo".to_string()]);
        }
    }
    let comspec = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string());
    (comspec, Vec::new())
}

#[cfg(unix)]
fn table() -> Vec<Entry> {
    use std::collections::HashSet;

    let mut paths: Vec<String> = Vec::new();
    // /etc/shells 是系统登记的合法登录 shell 清单
    if let Ok(content) = std::fs::read_to_string("/etc/shells") {
        for line in content.lines() {
            let line = line.trim();
            if !line.is_empty() && !line.starts_with('#') {
                paths.push(line.to_string());
            }
        }
    }
    // $SHELL 可能不在 /etc/shells 里（用户自己装的），补上
    if let Some(shell) = std::env::var_os("SHELL") {
        paths.push(shell.to_string_lossy().into_owned());
    }

    let mut seen = HashSet::new();
    let mut entries = Vec::new();
    for path in paths {
        // 解析软链去重（macOS 上 /bin 常是 /usr/bin 的链接），顺便剔除已不存在的项
        let resolved =
            std::fs::canonicalize(&path).unwrap_or_else(|_| std::path::PathBuf::from(&path));
        if !resolved.is_file() {
            continue;
        }
        let id = resolved.to_string_lossy().into_owned();
        if !seen.insert(id.clone()) {
            continue;
        }
        let (name, kind) = describe(&id);
        entries.push(Entry {
            info: ShellInfo {
                id: id.clone(),
                label: format!("{name} ({id})"),
                name,
                kind,
            },
            program: id.clone(),
            args: crate::shell_env::login_args(&id),
        });
    }
    entries
}

#[cfg(unix)]
fn auto_shell() -> (String, Vec<String>) {
    let shell = crate::shell_env::default_shell();
    let args = crate::shell_env::login_args(&shell);
    (shell, args)
}

/// preference 为空串/None → 自动；非空 → 查本机候选表。
/// 查不到（换了机器，或者那个 shell 被卸了）也回自动，别让终端起不来。
pub(crate) fn resolve_shell(preference: Option<&str>) -> (String, Vec<String>) {
    if let Some(id) = preference.filter(|id| !id.is_empty()) {
        if let Some(found) = table().into_iter().find(|item| item.info.id == id) {
            return (found.program, found.args);
        }
    }
    auto_shell()
}

/// 「自动」对应的那条候选：id 为空串，名字和图标按它实际会起的 shell 来定。
fn auto_entry() -> Entry {
    let (program, args) = auto_shell();
    // 自动选中的若正好是候选表里的某条，直接借它的名字 / 图标：光看可执行文件名
    // 认不出 Git Bash（bin\bash.exe 会被当成普通 bash，图标和显示名都不对）。
    if let Some(found) = table().into_iter().find(|item| item.program == program) {
        return Entry {
            info: ShellInfo {
                id: String::new(),
                label: format!("自动 ({})", found.info.name),
                ..found.info
            },
            program: found.program,
            args: found.args,
        };
    }
    let (name, kind) = describe(&program);
    Entry {
        info: ShellInfo {
            id: String::new(),
            label: format!("自动 ({name})"),
            name,
            kind,
        },
        program,
        args,
    }
}

/// 设置面板的候选列表：第一项固定是「自动」，后面是本机真实探测到的 shell。
#[tauri::command]
pub fn shell_list() -> Vec<ShellInfo> {
    let mut list = vec![auto_entry().info];
    list.extend(table().into_iter().map(|item| item.info));
    list
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_shell_has_a_program() {
        assert!(!auto_shell().0.is_empty());
    }

    #[test]
    fn unknown_or_empty_preference_falls_back_to_auto() {
        let auto = auto_shell().0;
        assert_eq!(resolve_shell(Some("definitely-not-a-shell")).0, auto);
        assert_eq!(resolve_shell(Some("")).0, auto);
        assert_eq!(resolve_shell(None).0, auto);
    }

    #[test]
    fn shell_list_starts_with_auto() {
        let list = shell_list();
        assert!(!list.is_empty());
        assert_eq!(list[0].id, "");
        // tab 靠这两个字段画图标和名字，空了界面就只剩占位
        assert!(!list[0].name.is_empty());
        assert!(!list[0].kind.is_empty());
    }

    #[test]
    fn describe_groups_shells_that_share_a_logo() {
        // POSIX 系（含 Debian 的 dash、BSD 的 ksh）共用 bash 的图标，显示名仍是自己
        assert_eq!(
            describe("/bin/dash"),
            ("dash".to_string(), "bash".to_string())
        );
        assert_eq!(
            describe("/usr/bin/ksh"),
            ("ksh".to_string(), "bash".to_string())
        );
        assert_eq!(describe("/bin/sh"), ("sh".to_string(), "bash".to_string()));
        // C shell 家族单独一类
        assert_eq!(
            describe("/bin/tcsh"),
            ("tcsh".to_string(), "csh".to_string())
        );
        assert_eq!(describe("/bin/zsh"), ("zsh".to_string(), "zsh".to_string()));
        // 认不出的落到通用图标，别乱套 logo
        assert_eq!(describe("/usr/bin/weird-shell").1, "shell");
    }
}
