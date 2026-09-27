#![allow(linker_messages)]

mod agent;
mod ai;
mod cli_sessions;
mod dev;
mod fs_api;
mod git;
mod pty;
mod secrets;
mod shell_env;
mod shells;
mod watcher;
mod windows;

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
        .manage(windows::WindowRegistry::new())
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            shells::shell_list,
            fs_api::fs_root,
            fs_api::fs_set_root,
            fs_api::fs_list_dir,
            fs_api::fs_search_files,
            fs_api::fs_search_content,
            fs_api::fs_replace_one,
            fs_api::fs_replace_all,
            fs_api::fs_read_file,
            fs_api::fs_read_image,
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
            git::git_ignored,
            git::git_add_to_ignore,
            ai::ai_generate_commit_message,
            ai::ai_explain_change,
            ai::ai_test_provider,
            ai::ai_list_provider_models,
            secrets::secret_set,
            secrets::secret_delete,
            secrets::secret_status,
            dev::dev_ai_overrides,
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
            windows::project_window_open,
        ])
        // 关窗时把该窗口的状态分片一起清掉：终端 shell、opencode 进程、目录监听
        // 都是按 label 存的，不主动收就会一直挂在后台（前端卸载时的清理只管它自己
        // 那点，进程侧的得由此处兜住）
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let label = window.label().to_string();
                let app = window.app_handle();
                if let Some(state) = app.try_state::<fs_api::FsState>() {
                    state.remove(&label);
                }
                if let Some(state) = app.try_state::<watcher::WatchState>() {
                    state.stop(&label);
                }
                if let Some(state) = app.try_state::<agent::AgentState>() {
                    state.kill_window(&label);
                }
                if let Some(state) = app.try_state::<pty::PtyState>() {
                    state.kill_window(&label);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| match event {
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                if let Some(state) = app.try_state::<pty::PtyState>() {
                    state.kill_all();
                }
                // 智能体是常驻的 opencode 子进程，退出时必须带走（每个窗口一个）
                if let Some(state) = app.try_state::<agent::AgentState>() {
                    state.kill_all();
                }
                // 目录监听的防抖线程也跟着收摊，别留游离线程
                if let Some(state) = app.try_state::<watcher::WatchState>() {
                    state.stop_all();
                }
            }
            _ => {}
        });
}
