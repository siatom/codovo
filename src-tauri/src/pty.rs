use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine;
use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::ipc::Channel;

/// PTY 输出走 base64 而非字符串：多字节 UTF-8 会被 read() 从中间截断，
/// 后端一旦 decode 就产生乱码。这里只搬运字节，由前端 xterm 自己拼。
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PtyEvent {
    Data { data: String },
    Exit { code: i32 },
}

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// 这个会话属于哪个工作区（工作区根）。关闭工作区时按它收摊，否则 shell 会在后台
    /// 留下；空串表示不属于任何工作区（比如没选工作区时开的终端）。
    owner: String,
}

struct Inner {
    sessions: Mutex<HashMap<u32, PtySession>>,
    next_id: AtomicU32,
}

pub struct PtyState {
    inner: Arc<Inner>,
}

impl PtyState {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Inner {
                sessions: Mutex::new(HashMap::new()),
                next_id: AtomicU32::new(1),
            }),
        }
    }

    /// 应用退出时调用，避免留下游离的 shell 进程。
    pub fn kill_all(&self) {
        let mut sessions = match self.inner.sessions.lock() {
            Ok(s) => s,
            Err(_) => return,
        };
        for (_, mut session) in sessions.drain() {
            let _ = session.killer.kill();
        }
    }

    /// 关闭工作区时调用：只收这个工作区开的 shell。PTY 池是全局的（会话按 id 区分），
    /// 但归属工作区记在 `owner` 上，不然工作区关掉后 shell 还挂在后台。
    pub fn kill_workspace(&self, root: &str) -> usize {
        let mut sessions = match self.inner.sessions.lock() {
            Ok(s) => s,
            Err(_) => return 0,
        };
        let ids: Vec<u32> = sessions
            .iter()
            .filter(|(_, session)| session.owner == root)
            .map(|(id, _)| *id)
            .collect();
        for id in &ids {
            if let Some(mut session) = sessions.remove(id) {
                let _ = session.killer.kill();
                // drop 掉 master 才会关闭 ConPTY，否则子进程可能残留
                drop(session);
            }
        }
        ids.len()
    }
}

/// 没选工作区时 shell 的落点。不设的话会继承应用进程的 cwd，
/// 打包后从开始菜单启动时那往往是 System32 之类的地方。
/// cli_sessions 也要用（会话记录在用户主目录下），所以放开到 crate 内。
pub(crate) fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    let key = "USERPROFILE";
    #[cfg(unix)]
    let key = "HOME";

    std::env::var_os(key)
        .map(PathBuf::from)
        .filter(|dir| dir.is_dir())
}

struct SpawnedShell {
    master: Box<dyn MasterPty + Send>,
    reader: Box<dyn Read + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

/// 起一个真实 shell。抽出来是为了能在单元测试里直接验证 PTY 通路。
/// `shell` 是设置里选中的候选 id，空/None 表示走自动（见 shells::resolve_shell）。
fn open_shell(
    cwd: Option<&str>,
    cols: u16,
    rows: u16,
    shell: Option<&str>,
) -> Result<SpawnedShell, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("打开 PTY 失败: {e}"))?;

    let (program, args) = crate::shells::resolve_shell(shell);
    let mut cmd = CommandBuilder::new(&program);
    for arg in &args {
        cmd.arg(arg);
    }
    let workdir = cwd
        .filter(|dir| !dir.is_empty() && Path::new(dir).is_dir())
        .map(PathBuf::from)
        .or_else(home_dir);
    if let Some(dir) = workdir.as_ref() {
        cmd.cwd(dir);
    }
    // PATH 只有 macOS 需要显式喂：GUI 应用没有终端父进程，拿不到用户登录 shell 里的 PATH。
    // Windows 上绝不能覆盖——portable-pty 每次 spawn 都会重读注册表（system + user PATH 合并），
    // 显式设成进程自身那份 PATH 反而把它钉死在 CodeDock 启动那一刻的旧值，启动之后新改的
    // PATH 就永远进不来（Linux 下 get_base_env 不读额外配置，设与不设等价，故一并省去）。
    #[cfg(target_os = "macos")]
    if let Some(path) = crate::shell_env::resolved_path(&program, workdir.as_deref()) {
        cmd.env("PATH", path);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("启动 {program} 失败: {e}"))?;
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("读取 PTY 失败: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("写入 PTY 失败: {e}"))?;

    Ok(SpawnedShell {
        master: pair.master,
        reader,
        writer,
        child,
    })
}

#[tauri::command]
pub fn pty_spawn(
    state: tauri::State<'_, PtyState>,
    on_event: Channel<PtyEvent>,
    root: String,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    // 设置里选的 shell 候选 id；null 表示自动
    shell: Option<String>,
) -> Result<u32, String> {
    let owner = root;
    let spawned = open_shell(cwd.as_deref(), cols, rows, shell.as_deref())?;
    let killer = spawned.child.clone_killer();
    let master = spawned.master;
    let writer = spawned.writer;
    let mut reader = spawned.reader;
    let mut child = spawned.child;

    let id = state.inner.next_id.fetch_add(1, Ordering::Relaxed);

    // 必须先登记会话，再启动 waiter：否则 shell 启动即退时（比如未装发行版的 wsl.exe），
    // waiter 会在 insert 之前就 remove 掉一个还不存在的 id（空操作），主线程随后 insert，
    // 留下一个永远删不掉的会话——master / writer / killer 全泄漏，且前端拿到的 id 已经死了。
    // 登记在前则 waiter 的 remove 必然作用在这个会话上，退出路径也就收得干净。
    state
        .inner
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(
            id,
            PtySession {
                master,
                writer,
                killer,
                owner,
            },
        );

    let reader_channel = on_event.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    if reader_channel.send(PtyEvent::Data { data }).is_err() {
                        break;
                    }
                }
            }
        }
    });

    let waiter_channel = on_event;
    let inner = state.inner.clone();
    std::thread::spawn(move || {
        let code = child
            .wait()
            .map(|status| status.exit_code() as i32)
            .unwrap_or(-1);
        let _ = waiter_channel.send(PtyEvent::Exit { code });
        if let Ok(mut sessions) = inner.sessions.lock() {
            sessions.remove(&id);
        }
    });

    Ok(id)
}

#[tauri::command]
pub fn pty_write(state: tauri::State<'_, PtyState>, id: u32, data: String) -> Result<(), String> {
    let mut sessions = state.inner.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions.get_mut(&id).ok_or("PTY 会话不存在")?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(
    state: tauri::State<'_, PtyState>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state.inner.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions.get(&id).ok_or("PTY 会话不存在")?;
    session
        .master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(state: tauri::State<'_, PtyState>, id: u32) -> Result<(), String> {
    let removed = state
        .inner
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&id);
    if let Some(mut session) = removed {
        let _ = session.killer.kill();
        // drop 掉 master 才会关闭 ConPTY，否则子进程可能残留
        drop(session);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    /// 终端是这个应用的核心，但没法靠界面点击来自动验证，
    /// 所以在这里跑一次真实的 PTY 往返：起 shell -> 写命令 -> 读结果。
    #[test]
    fn shell_roundtrip_through_pty() {
        let (program, _) = crate::shells::resolve_shell(None);
        let mut shell = open_shell(None, 120, 30, None).expect("打开 PTY 失败");
        let lower = program.to_lowercase();
        let is_cmd = lower.ends_with("cmd.exe");
        let is_pwsh = lower.ends_with("pwsh")
            || lower.ends_with("pwsh.exe")
            || lower.ends_with("powershell.exe");
        let marker = format!("codedock-ok-{}", std::process::id());

        // 命令文本里不能出现 marker 本身，否则终端回显输入行就会造成假阳性，
        // 所以两种 shell 都得靠「拼两段」求值——但拼法不通用：
        // PowerShell 的裸表达式 `'a' + 'b'` 会拼，POSIX shell 没这回事，得借 printf。
        let command = if is_cmd {
            "ver".to_string()
        } else if is_pwsh {
            format!("'codedock' + '-ok-{}'", std::process::id())
        } else {
            format!("printf '%s%s\\n' 'codedock' '-ok-{}'", std::process::id())
        };
        // 只发 \r：真实终端的 Enter 就是 \r，多带一个 \n 会让 pwsh 进入续行
        shell
            .writer
            .write_all(format!("{command}\r").as_bytes())
            .expect("写入 PTY 失败");
        shell.writer.flush().expect("flush 失败");

        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let mut reader = shell.reader;
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                    break;
                }
            }
        });

        let deadline = Instant::now() + Duration::from_secs(30);
        let mut collected = Vec::new();
        while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
            match rx.recv_timeout(remaining) {
                Ok(chunk) => {
                    // pwsh 启动时会发 ESC[6n（查光标位置）并阻塞等应答。
                    // 真实运行时由 xterm 通过 onData 自动回，这里手工模拟一下。
                    let queries = chunk
                        .windows(4)
                        .filter(|window| *window == b"\x1b[6n")
                        .count();
                    for _ in 0..queries {
                        let _ = shell.writer.write_all(b"\x1b[1;1R");
                    }
                    if queries > 0 {
                        let _ = shell.writer.flush();
                    }

                    collected.extend_from_slice(&chunk);
                    let haystack = String::from_utf8_lossy(&collected);
                    // cmd 没有等价的无副作用求值写法，就退回"输入被回显"这个弱判据
                    let reached = if is_cmd {
                        haystack.contains("ver")
                    } else {
                        haystack.contains(&marker)
                    };
                    if reached {
                        break;
                    }
                }
                Err(_) => break,
            }
        }

        let _ = shell.child.kill();
        drop(shell.master);

        // base64 是前后端唯一的传输格式，顺手确认它不丢字节
        let encoded = base64::engine::general_purpose::STANDARD.encode(&collected);
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .expect("base64 解码失败");
        assert_eq!(decoded, collected);

        let text = String::from_utf8_lossy(&collected);
        assert!(
            !collected.is_empty(),
            "shell({}) 没有任何输出，PTY 通路可能断了",
            program
        );

        if !is_cmd {
            // 输出里出现 marker 说明 shell 真的解析并执行了我们的输入，
            // 而不只是 ConPTY 在回显
            assert!(
                text.contains(&marker),
                "shell({}) 没打印出 {marker}，实际收到 {} 字节: {text:?}",
                program,
                collected.len()
            );
        }
    }
}
