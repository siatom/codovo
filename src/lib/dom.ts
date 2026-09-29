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
