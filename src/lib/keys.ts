/**
 * 快捷键的修饰键判定。三端差异只在这里处理，别在各组件里各写一份。
 */

/**
 * 只看 UA 就够：这里只回答「主修饰键认 Cmd 还是 Ctrl」，判错顶多是快捷键不灵，
 * 不存在误判系统能力的问题。
 */
export const IS_MAC = /mac/i.test(navigator.userAgent);

/**
 * 事件里是否按下了「主修饰键」——macOS 是 Cmd，其余平台是 Ctrl。
 *
 * 带 Alt 的一律不算：部分键盘布局的 AltGr 会被报成 Ctrl+Alt，认了就会把正常
 * 输入当成快捷键抢掉。
 */
export function isPrimaryModifier(event: {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}): boolean {
  if (event.altKey) return false;
  return IS_MAC ? event.metaKey : event.ctrlKey;
}
