/**
 * 面板宽度动画期间，暂停 xterm WebGL 渲染器对 canvas 的 `device-pixel-content-box` 回调。
 *
 * 这个回调本身没错：它负责在设备像素比变化时重设 WebGL 画布。但侧栏 / 分隔条让终端
 * 的位置带小数移动时，canvas 覆盖的设备像素数会在相邻两个值之间来回跳（例如 2398/2399），
 * 回调于是每帧都重建画布、重绘整屏（实测 10~25ms/帧），画面看起来就是终端内容在抖。
 *
 * 动画期间只是把回调换成空函数，canvas 的 DOM、尺寸和内容都不动；动画结束由调用方
 * 恢复。没有可用的渲染器（没开 GPU 加速 / xterm 版本变了）时静默返回空操作。
 * 访问的是 addon 的私有字段，升级 xterm 时若改名，这里会退化成“不暂停”，不影响功能。
 */
export function pauseDevicePixelSync(addon: unknown): () => void {
  const renderer = (addon as { _renderer?: Record<string, unknown> } | null)?._renderer;
  if (!renderer) return () => {};
  const original = renderer._setCanvasDevicePixelDimensions;
  if (typeof original !== "function") return () => {};
  const marker = "__codovoDevicePixelPaused";
  if (renderer[marker]) return () => {};
  let latest: [number, number] | null = null;
  renderer[marker] = true;
  renderer._setCanvasDevicePixelDimensions = (width: number, height: number) => {
    latest = [width, height];
  };
  return () => {
    if (renderer[marker] !== true) return;
    renderer[marker] = false;
    renderer._setCanvasDevicePixelDimensions = original;
    // 动画期间如果设备像素尺寸真的变了（比如窗口被拖到另一块屏），恢复时补最后一次；
    // 只是小数像素来回跳的话，latest 和当前画布一致，这次调用本身是幂等的。
    if (latest) {
      (original as (width: number, height: number) => void).call(renderer, latest[0], latest[1]);
    }
  };
}
