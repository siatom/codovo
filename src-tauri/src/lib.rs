#![allow(linker_messages)]

mod agent;
mod ai;
mod cli_sessions;
mod database;
mod db_agent;
mod dev;
mod encoding;
mod feedback;
mod fs_api;
mod git;
mod installer;
mod local_fs;
mod pty;
mod remote;
mod secrets;
mod shell_env;
mod shells;
mod tray;
mod watcher;

use tauri::{Emitter, Manager};

/// 数据库 Agent 的 MCP 服务入口。main() 在 Tauri 初始化**之前**按 `--mcp-db` 分流到这里，
/// 所以这条路径不会建窗口、也不碰任何 Tauri 状态。返回进程退出码。
pub fn run_db_mcp() -> i32 {
    db_agent::run_stdio()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 单实例必须第一个注册：第二个实例被这个插件挡下后会立刻退出，不该再跑后面插件的 setup。
        // 回调在「已经在跑的那个」里执行——它可能被收进了托盘，把主窗口唤回来
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            tray::show_main(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(pty::PtyState::new())
        .manage(fs_api::FsState::new())
        .manage(watcher::WatchState::new())
        .manage(agent::AgentState::new())
        .manage(remote::RemoteState::new())
        .manage(database::DbState::new())
        .setup(|app| {
            // 托盘是「关掉窗口后还能回来」的唯一入口，起不来就没法后台常驻了
            tray::init(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // 关窗一律先拦下：界面还没告诉我们是收进托盘还是真退出。判断依据
            // （开着几个工作区、用户是不是勾了「不再提醒」）全在前端，后端只管转发
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.emit("app://close-requested", ());
            }
        })
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            shells::shell_list,
            fs_api::workspace_activate,
            fs_api::workspace_register,
            fs_api::workspace_close,
            fs_api::paths_exist,
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
            fs_api::fs_move,
            fs_api::fs_copy,
            installer::check_dependencies,
            installer::install_dependency,
            git::git_status,
            git::git_init,
            git::git_worktree_list,
            git::git_stage,
            git::git_unstage,
            git::git_discard,
            git::git_file_hunks,
            git::git_apply_patch,
            git::git_apply_lines,
            git::git_commit,
            git::git_commit_groups,
            git::git_amend,
            git::git_undo_commit,
            git::git_branches,
            git::git_switch_branch,
            git::git_create_branch,
            git::git_tag_list,
            git::git_create_tag,
            git::git_delete_tag,
            git::git_stash_list,
            git::git_stash_push,
            git::git_stash_pop,
            git::git_stash_apply,
            git::git_stash_drop,
            git::git_file_diff,
            git::git_log,
            git::git_commit_files,
            git::git_compare_files,
            git::git_commit_stat,
            git::git_unpushed,
            git::git_fetch,
            git::git_pull,
            git::git_push,
            git::git_merge,
            git::git_merge_abort,
            git::git_merge_continue,
            git::git_ignored,
            git::git_add_to_ignore,
            git::git_clone,
            ai::ai_generate_commit_plan,
            ai::ai_explain_change,
            ai::ai_generate_feedback_body,
            ai::ai_test_provider,
            ai::ai_list_provider_models,
            secrets::secret_set,
            secrets::secret_delete,
            secrets::secret_status,
            feedback::feedback_target,
            feedback::feedback_cli_status,
            feedback::feedback_list,
            feedback::feedback_submit,
            feedback::feedback_refresh,
            feedback::feedback_delete,
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
            remote::remote_connect,
            remote::remote_test_connection,
            remote::remote_write,
            remote::remote_resize,
            remote::remote_disconnect,
            remote::sftp_home,
            remote::sftp_list,
            remote::sftp_mkdir,
            remote::sftp_remove,
            remote::sftp_rename,
            remote::sftp_upload,
            remote::sftp_download,
            local_fs::local_home,
            local_fs::local_list_dir,
            local_fs::local_mkdir,
            local_fs::local_rename,
            local_fs::local_remove,
            database::db_connect,
            database::db_disconnect,
            database::db_test_connection,
            database::db_databases,
            database::db_schemas,
            database::db_tables,
            database::db_query,
            db_agent::db_agent_set_target,
            tray::app_quit,
            tray::app_hide_to_tray,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| match event {
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                if let Some(state) = app.try_state::<pty::PtyState>() {
                    state.kill_all();
                }
                // 智能体是常驻的 opencode 子进程，退出时必须带走（每个工作区一个）
                if let Some(state) = app.try_state::<agent::AgentState>() {
                    state.kill_all();
                }
                // 目录监听的防抖线程也跟着收摊，别留游离线程
                if let Some(state) = app.try_state::<watcher::WatchState>() {
                    state.stop();
                }
                // 远程连接是常驻的 SSH 会话，退出时通知它们收摊
                if let Some(state) = app.try_state::<remote::RemoteState>() {
                    state.kill_all();
                }
                // 数据库连接池也跟着收掉
                if let Some(state) = app.try_state::<database::DbState>() {
                    state.kill_all();
                }
            }
            // macOS 点 Dock 图标：窗口可能被收起来了，亮回来（关窗只隐藏，不走 Exit）
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => tray::show_main(app),
            _ => {}
        });
}
