#![allow(linker_messages)]

mod agent;
mod ai;
mod cli_sessions;
mod fs_api;
mod git;
mod pty;
mod shell_env;
mod watcher;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(pty::PtyState::new())
        .manage(fs_api::FsState::new())
        .manage(watcher::WatchState::new())
        .manage(agent::AgentState::new())
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            fs_api::fs_root,
            fs_api::fs_set_root,
            fs_api::fs_list_dir,
            fs_api::fs_search_files,
            fs_api::fs_search_content,
            fs_api::fs_replace_one,
            fs_api::fs_replace_all,
            fs_api::fs_read_file,
            fs_api::fs_write_file,
            fs_api::fs_create_file,
            fs_api::fs_create_directory,
            fs_api::fs_rename,
            fs_api::fs_delete,
            git::git_status,
            git::git_stage,
            git::git_unstage,
            git::git_discard,
            git::git_commit,
            git::git_file_diff,
            git::git_log,
            git::git_commit_files,
            git::git_fetch,
            git::git_pull,
            git::git_push,
            ai::ai_generate_commit_message,
            cli_sessions::cli_list_sessions,
            agent::agent_start,
            agent::agent_status,
            agent::agent_stop,
            agent::agent_create_session,
            agent::agent_list_sessions,
            agent::agent_messages,
            agent::agent_send,
            agent::agent_abort,
            agent::agent_delete_session,
            agent::agent_rename_session,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| match event {
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                if let Some(state) = app.try_state::<pty::PtyState>() {
                    state.kill_all();
                }
                // 智能体是个常驻的 opencode 子进程，退出时必须带走
                if let Some(state) = app.try_state::<agent::AgentState>() {
                    state.kill();
                }
            }
            _ => {}
        });
}
