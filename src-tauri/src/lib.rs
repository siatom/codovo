#![allow(linker_messages)]

mod agent;
mod agent_config;
mod ai;
mod app_agent;
mod cicd;
mod agent_protocol;
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
mod natural_sort;
mod preview;
mod preview_agent;
mod pty;
mod remote;
mod runtime;
mod secrets;
mod shell_env;
mod shells;
mod titlebar;
mod tray;
mod watcher;

use tauri::{Emitter, Manager};

/// 数据库 Agent 的 MCP 服务入口。main() 在 Tauri 初始化**之前**按 `--mcp-db` 分流到这里，
/// 所以这条路径不会建窗口、也不碰任何 Tauri 状态。返回进程退出码。
pub fn run_db_mcp() -> i32 {
    db_agent::run_stdio()
}

/// 应用助手（界面操作）的 MCP 服务入口。同样在 Tauri 初始化之前分流，返回进程退出码。
pub fn run_app_mcp() -> i32 {
    app_agent::run_stdio()
}

/// 预览助手（启动/停止项目预览）的 MCP 服务入口。同样在 Tauri 初始化之前分流。
pub fn run_preview_mcp() -> i32 {
    preview_agent::run_stdio()
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
        .manage(local_fs::LocalWatchState::new())
        .manage(agent::AgentState::new())
        .manage(remote::RemoteState::new())
        .manage(database::DbState::new())
        .manage(preview::PreviewState::new())
        .manage(cicd::CicdState::new())
        .manage(runtime::RuntimeState::new())
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
            fs_api::paths_present,
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
            installer::check_agent_clis,
            installer::install_dependency,
            git::git_status,
            git::git_init,
            git::git_worktree_list,
            git::git_worktree_prune,
            git::git_worktree_status,
            git::workstream_list,
            git::workstream_merge,
            git::workstream_remove,
            git::workstream_create,
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
            git::git_resolve_conflict,
            git::git_ignored,
            git::git_add_to_ignore,
            git::git_clone,
            ai::ai_generate_commit_plan,
            ai::ai_explain_change,
            ai::ai_generate_feedback_body,
            ai::ai_test_provider,
            ai::ai_list_provider_models,
            ai::ai_suggest_cicd_config,
            ai::ai_diagnose_cicd,
            ai::ai_diagnose_preview,
            ai::ai_translate_text,
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
            local_fs::local_watch_dir,
            local_fs::local_unwatch_dir,
            database::db_connect,
            database::db_disconnect,
            database::db_test_connection,
            database::db_databases,
            database::db_schemas,
            database::db_tables,
            database::db_table_structure,
            database::db_query,
            database::db_export,
            db_agent::db_agent_set_target,
            app_agent::app_agent_take_request,
            app_agent::app_agent_respond,
            preview::preview_detect,
            preview::preview_start,
            preview::preview_stop,
            preview::preview_status,
            preview_agent::preview_agent_take_request,
            preview_agent::preview_agent_respond,
            cicd::cicd_read_config,
            cicd::cicd_write_config,
            cicd::cicd_detect_config,
            cicd::cicd_run,
            cicd::cicd_stop,
            cicd::cicd_status,
            runtime::runtime_start,
            runtime::runtime_cancel,
            runtime::runtime_stop,
            agent_protocol::protocol_normalize_event,
            agent_protocol::protocol_create_approval,
            agent_protocol::protocol_decide_approval,
            agent_protocol::protocol_resource_conflicts,
            agent_protocol::protocol_index_workspace_resources,
            agent_protocol::protocol_sanitize_diagnostics,
            agent_config::agent_config_read,
            agent_config::agent_config_write,
            tray::app_quit,
            tray::app_hide_to_tray,
            titlebar::window_minimize,
            titlebar::window_toggle_maximize,
            titlebar::window_is_maximized,
            titlebar::window_close,
            titlebar::window_show_system_menu,
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
                // 本地面板的按需监听同样收掉
                if let Some(state) = app.try_state::<local_fs::LocalWatchState>() {
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
                // 预览 dev server 是常驻子进程，退出时带走（每个工作区一个）
                if let Some(state) = app.try_state::<preview::PreviewState>() {
                    state.kill_all();
                }
                // CICD 流水线可能正卡在某条命令上，退出时打断并 kill 当前子进程
                if let Some(state) = app.try_state::<cicd::CicdState>() {
                    state.kill_all();
                }
                if let Some(state) = app.try_state::<runtime::RuntimeState>() {
                    state.kill_all();
                }
            }
            // macOS 点 Dock 图标：窗口可能被收起来了，亮回来（关窗只隐藏，不走 Exit）
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => tray::show_main(app),
            _ => {}
        });
}
