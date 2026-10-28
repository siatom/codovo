/**
 * 预览助手的哨兵 root。
 *
 * 它不是工作区路径，只是给每个工作区一个独立的助手槽位；后端
 * `src-tauri/src/agent/mod.rs` 的 `preview_root` 与它对齐。
 *
 * 预览工具本身已经在主进程里（`src-tauri/src/agent/tools/preview.rs`），
 * 不再需要前端转发，所以这个文件只剩这一条。
 */
export function previewAgentRoot(workspaceRoot: string): string {
  return `__preview_agent__::${workspaceRoot}`;
}
