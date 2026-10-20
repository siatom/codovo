/**
 * 判一次点击算不算「点在空白处」，供侧栏 / 右边栏点空白切换显隐用。
 *
 * 两条排除：
 * - 本身有行为的元素（按钮、链接、输入框、列表行、拖动分隔条）；
 * - 祖先里出现 fixed 定位的——菜单和对话框铺的都是 `fixed inset-0` 透明遮罩
 *   （见各处「铺一层遮罩接住外部点击」），那一下是先用来关它们的，
 *   不能顺手把面板也收掉，否则关个菜单就丢一块布局。
 */
export function isBlankClick(event: { target: EventTarget | null }): boolean {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest("button, a, input, textarea, select, li, [role='separator']")) {
    return false;
  }
  for (let node: HTMLElement | null = target; node; node = node.parentElement) {
    if (window.getComputedStyle(node).position === "fixed") return false;
  }
  return true;
}

/**
 * 窗口级快捷键分发前的一道闸：焦点是不是落在「要独占键盘」的地方。
 *
 * 终端（xterm 的输入层）在 shell 里有自己的键义——Ctrl+B 是 readline 的光标左移、
 * Ctrl+PageDown 也被 TUI 用着，宿主抢了前台程序就没法用；文本输入框同理，在框里
 * Ctrl+, 不该被解释成「打开设置」。
 *
 * Monaco 的隐藏输入层是个 `<textarea>`，但它代表的就是编辑器本身——那里的
 * Ctrl+, / Ctrl+= 恰恰是要处理的，所以命中 `.monaco-editor` 时先返回 false。
 */
export function isTypingTarget(event: { target: EventTarget | null }): boolean {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest(".xterm")) return true;
  if (target.closest(".monaco-editor")) return false;
  if (target.isContentEditable) return true;
  return target.closest("input, textarea, select") !== null;
}
