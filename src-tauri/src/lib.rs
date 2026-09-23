mod fs_api;
mod git;
mod pty;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(pty::PtyState::new())
        .manage(fs_api::FsState::new())
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            fs_api::fs_root,
            fs_api::fs_set_root,
            fs_api::fs_list_dir,
            fs_api::fs_search_files,
            fs_api::fs_read_file,
            fs_api::fs_write_file,
            git::git_status,
            git::git_stage,
            git::git_unstage,
            git::git_commit,
            git::git_file_diff,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| match event {
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                if let Some(state) = app.try_state::<pty::PtyState>() {
                    state.kill_all();
                }
            }
            _ => {}
        });
}
