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

/** 动画落定的窗口级事件：用事件而不是模块内的 Set，开发态 HMR 换了模块实例也还能收到 */
const SETTLED_EVENT = "codedock:layout-settled";

/** 动画结束后的余量：留一帧给最后一帧布局落定 */
const SETTLE_MS = 340;

let timer: number | undefined;

/** 面板开始收放时调用（同一轮里多次调用只会延长同一次标记） */
export function beginLayoutAnimation(): void {
  document.body.classList.add(ANIMATING_CLASS);
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = undefined;
    document.body.classList.remove(ANIMATING_CLASS);
    window.dispatchEvent(new Event(SETTLED_EVENT));
  }, SETTLE_MS);
}

/** 这一帧是不是还在面板收放动画里 */
export function isLayoutAnimating(): boolean {
  return document.body.classList.contains(ANIMATING_CLASS);
}

/** 动画落定后统一补一次尺寸校正。返回退订函数 */
export function onLayoutSettled(listener: () => void): () => void {
  window.addEventListener(SETTLED_EVENT, listener);
  return () => window.removeEventListener(SETTLED_EVENT, listener);
}

/**
 * 和 styles.css 的 `--ease-dock` 同一条曲线：起步略快、尾段收柔。
 * 侧栏宽度动画用 rAF 自己跑（见 Sidebar），所以这里手写一份。
 */
export function easeDock(progress: number): number {
  const x1 = 0.22;
  const y1 = 1;
  const x2 = 0.36;
  const y2 = 1;
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const sampleDX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  let t = progress;
  // Newton-Raphson 反解 t，几次就够；曲线很陡时偶尔跑飞，下面用二分兜底
  for (let i = 0; i < 6; i++) {
    const dx = sampleX(t) - progress;
    if (Math.abs(dx) < 1e-6) return sampleY(t);
    const slope = sampleDX(t);
    if (Math.abs(slope) < 1e-6) break;
    t -= dx / slope;
  }
  if (t < 0 || t > 1 || !Number.isFinite(t)) {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (sampleX(mid) < progress) lo = mid;
      else hi = mid;
    }
    t = (lo + hi) / 2;
  }
  return sampleY(t);
}

/**
 * 让侧栏宽度落在设备像素上的最小整数步长（CSS px）。
 *
 * xterm 的 WebGL 渲染器会观察 canvas 的 `device-pixel-content-box`；canvas 的左边
 * 跟着侧栏宽度走，宽度带小数时这个盒子的尺寸会在相邻两个设备像素之间来回跳，
 * 渲染器每一帧都重设 canvas 并重绘终端（实测 10~25ms/帧），画面看起来就是内容在抖。
 * 把侧栏宽度按设备像素对齐后，盒子的尺寸稳定，整段动画只需要结束时 fit 一次。
 */
export function devicePixelStep(): number {
  const dpr = window.devicePixelRatio || 1;
  for (let step = 1; step <= 8; step++) {
    const scaled = dpr * step;
    if (Math.abs(scaled - Math.round(scaled)) < 1e-6) return step;
  }
  return 1;
}

/** 把宽度对齐到设备像素步长；`step` 可复用调用方已经算好的值 */
export function alignToDevice(value: number, step = devicePixelStep()): number {
  return Math.round(value / step) * step;
}
