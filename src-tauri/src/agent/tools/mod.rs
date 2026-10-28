//! 工具集合：按助手种类装配。
//!
//! 三组工具都不需要文件 / shell —— 应用助手只动界面，预览助手只起停预览，
//! 数据库助手只跑只读 SQL。切 Rig 之前 opencode 自带的那些工具在配置里被逐个关掉了，
//! 现在干脆不注册。

pub mod app;
pub mod db;
pub mod preview;

use std::path::Path;
use std::sync::Arc;

use rig_core::tool::DynamicTool;
use tauri::AppHandle;

use crate::agent::prompt::Kind;

/// 跨轮次复用的工具依赖：界面桥与数据库连接缓存。
pub struct Deps {
    pub bridge: Arc<app::AppBridge>,
    pub db: Arc<db::DbTools>,
}

/// 按助手种类装配工具。
pub fn build(kind: Kind, deps: &Deps, app: &AppHandle, workspace: &Path) -> Vec<DynamicTool> {
    match kind {
        Kind::App => app::tools(Arc::clone(&deps.bridge)),
        Kind::Preview => preview::tools(app.clone(), workspace.to_string_lossy().into_owned()),
        Kind::Database => db::tools(Arc::clone(&deps.db)),
    }
}
