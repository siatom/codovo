/**
 * 面板收放动画的全局标记。
 *
 * 侧栏 / 右栏收放会连续改变中间终端、编辑器的宽度。终端这类「按容器尺寸重新排版」
 * 的组件如果在动画中间去 fit，画面会反复重排，看起来就是内容在抖。这里统一标出
 * 动画时段：终端先别量尺寸，等动画结束的信号再补一次。
 *
 * 只用 body class + 定时器，不引入跨组件的状态订阅；动画时长变化时改这里的
 * SETTLE_MS 即可（比 styles.css 里最长的 300ms 多留一点余量）。
 */
const ANIMATING_CLASS = "codedock-layout-animating";

/** 动画结束后的余量：留一帧给最后一帧布局落定 */
const SETTLE_MS = 340;

let timer: number | undefined;
const settleListeners = new Set<() => void>();

/** 面板开始收放时调用（同一轮里多次调用只会延长同一次标记） */
export function beginLayoutAnimation(): void {
  document.body.classList.add(ANIMATING_CLASS);
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = undefined;
    document.body.classList.remove(ANIMATING_CLASS);
    // 复制一份再遍历：回调里可能退订
    for (const listener of [...settleListeners]) listener();
  }, SETTLE_MS);
}

/** 这一帧是不是还在面板收放动画里 */
export function isLayoutAnimating(): boolean {
  return document.body.classList.contains(ANIMATING_CLASS);
}

/** 动画落定后统一补一次尺寸校正。返回退订函数 */
export function onLayoutSettled(listener: () => void): () => void {
  settleListeners.add(listener);
  return () => settleListeners.delete(listener);
}
