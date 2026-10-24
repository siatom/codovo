//! 可取消、可超时的本地进程 Supervisor。
//!
//! 现有 `pty.rs` 继续负责交互式终端；这个模块服务于结构化 Adapter 和 Fake Adapter，
//! 负责进程意图、输出、取消、超时和资源回收，不把取消误报成成功。

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::ipc::Channel;

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum RuntimeEvent {
    Started {
        id: u64,
        process_id: u32,
    },
    Output {
        id: u64,
        stream: String,
        data: String,
    },
    TimedOut {
        id: u64,
    },
    Exited {
        id: u64,
        code: Option<i32>,
    },
    Cancelled {
        id: u64,
    },
}

struct ProcessSlot {
    child: Arc<Mutex<Option<Child>>>,
    owner: String,
    channel: Channel<RuntimeEvent>,
}

struct Inner {
    next_id: AtomicU64,
    processes: Mutex<HashMap<u64, ProcessSlot>>,
}

pub struct RuntimeState {
    inner: Arc<Inner>,
}

impl RuntimeState {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Inner {
                next_id: AtomicU64::new(1),
                processes: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub fn kill_all(&self) {
        let mut processes = match self.inner.processes.lock() {
            Ok(value) => value,
            Err(_) => return,
        };
        for (_, slot) in processes.drain() {
            if let Ok(mut child) = slot.child.lock() {
                if let Some(child) = child.as_mut() {
                    let _ = child.kill();
                }
            }
        }
    }

    pub fn kill_owner(&self, owner: &str) -> usize {
        let mut processes = match self.inner.processes.lock() {
            Ok(value) => value,
            Err(_) => return 0,
        };
        let ids: Vec<u64> = processes
            .iter()
            .filter(|(_, slot)| slot.owner == owner)
            .map(|(id, _)| *id)
            .collect();
        for id in &ids {
            if let Some(slot) = processes.remove(id) {
                if let Ok(mut child) = slot.child.lock() {
                    if let Some(child) = child.as_mut() {
                        let _ = child.kill();
                    }
                }
            }
        }
        ids.len()
    }
}

impl Default for RuntimeState {
    fn default() -> Self {
        Self::new()
    }
}

#[tauri::command]
pub fn runtime_start(
    state: tauri::State<'_, RuntimeState>,
    on_event: Channel<RuntimeEvent>,
    owner: String,
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<u64, String> {
    if program.trim().is_empty() {
        return Err("运行命令不能为空".into());
    }
    let mut command = Command::new(&program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = cwd.filter(|value| !value.trim().is_empty()) {
        command.current_dir(cwd);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("启动运行进程失败：{error}"))?;
    let process_id = child.id();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let child = Arc::new(Mutex::new(Some(child)));
    let id = state.inner.next_id.fetch_add(1, Ordering::Relaxed);
    state
        .inner
        .processes
        .lock()
        .map_err(|error| error.to_string())?
        .insert(
            id,
            ProcessSlot {
                child: Arc::clone(&child),
                owner,
                channel: on_event.clone(),
            },
        );
    let _ = on_event.send(RuntimeEvent::Started { id, process_id });

    spawn_reader(id, "stdout", stdout, on_event.clone());
    spawn_reader(id, "stderr", stderr, on_event.clone());

    let inner = Arc::clone(&state.inner);
    let waiter_child = Arc::clone(&child);
    let waiter_channel = on_event.clone();
    thread::spawn(move || {
        // 轮询 try_wait，让 timeout/cancel 线程仍能取得锁并 kill 子进程。
        let status = loop {
            let result = waiter_child.lock().ok().and_then(|mut slot| {
                slot.as_mut().map(|child| child.try_wait())
            });
            match result {
                Some(Ok(Some(status))) => break Some(status),
                Some(Ok(None)) => thread::sleep(Duration::from_millis(20)),
                Some(Err(_)) | None => break None,
            }
        };
        let _ = waiter_channel.send(RuntimeEvent::Exited {
            id,
            code: status.and_then(|value| value.code()),
        });
        if let Ok(mut processes) = inner.processes.lock() {
            processes.remove(&id);
        }
    });

    if let Some(timeout_ms) = timeout_ms.filter(|value| *value > 0) {
        let timeout_child = Arc::clone(&child);
        let timeout_channel = on_event;
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(timeout_ms));
            if let Ok(mut child) = timeout_child.lock() {
                if let Some(child) = child.as_mut() {
                    let _ = child.kill();
                    let _ = timeout_channel.send(RuntimeEvent::TimedOut { id });
                }
            }
        });
    }
    Ok(id)
}

fn spawn_reader<R: Read + Send + 'static>(
    id: u64,
    stream: &str,
    reader: Option<R>,
    channel: Channel<RuntimeEvent>,
) {
    let Some(reader) = reader else {
        return;
    };
    let stream = stream.to_string();
    thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let _ = channel.send(RuntimeEvent::Output {
                        id,
                        stream: stream.clone(),
                        data: line.clone(),
                    });
                }
            }
        }
    });
}

#[tauri::command]
pub fn runtime_cancel(state: tauri::State<'_, RuntimeState>, id: u64) -> Result<bool, String> {
    let processes = state
        .inner
        .processes
        .lock()
        .map_err(|error| error.to_string())?;
    let Some(slot) = processes.get(&id) else {
        return Ok(false);
    };
    let mut child = slot.child.lock().map_err(|error| error.to_string())?;
    if let Some(child) = child.as_mut() {
        child.kill().map_err(|error| error.to_string())?;
        let _ = slot.channel.send(RuntimeEvent::Cancelled { id });
        Ok(true)
    } else {
        Ok(false)
    }
}

#[tauri::command]
pub fn runtime_stop(state: tauri::State<'_, RuntimeState>, id: u64) -> Result<bool, String> {
    runtime_cancel(state, id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supervisor_starts_empty() {
        let state = RuntimeState::new();
        assert_eq!(state.kill_owner("missing"), 0);
    }
}
