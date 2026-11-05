//! 删除到系统回收站。
//!
//! 用户从文件树 / 本地面板点「删除」走这里：删错了还能从系统回收站捞回来。
//! 内部操作（粘贴撞名时的覆盖写、移动前的清场）仍然直接删，见 `fs_api::delete_at`——
//! 那些场景没有"用户刚删了什么"的语义，塞进回收站只会制造垃圾。

use std::path::Path;

/// 把一项（文件或整个目录）移到系统回收站。
///
/// 返回的错误只说回收站这一步为什么失败（网络盘、跨盘、权限等），
/// 路径由调用方补进消息里，保持各模块原有的错误格式。
pub(crate) fn move_to_trash(target: &Path) -> Result<(), String> {
    trash::delete(target).map_err(|error| error.to_string())
}
