/**
 * 全屏程序退出时兜底复位的终端模式：鼠标上报、焦点上报、win32 键盘输入。
 *
 * 实测 opencode 2.1.1：启动时打开鼠标上报（1000 / 1002 / 1003 / 1006）、焦点上报（1004）、
 * win32 输入（9001），退出时只关了备用屏和 bracketed paste，这几个模式全留着。最要命的是
 * any-event 鼠标上报：之后鼠标在终端上每动一下，xterm 就把 `ESC[<b;x;yM` 写进 PTY，
 * shell 提示符上不断冒出乱码，Ctrl+C 清掉后一动鼠标又回来。
 *
 * 只复位「离开 TUI 就没有意义」的模式；bracketed paste（2004）不能动——shell 的 readline
 * 自己在用它。复位序列写进 xterm 自己的解析器（`term.write`），不会回灌 PTY。
 */
export const TUI_MODE_RESET =
  "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1004l\x1b[?9001l";

/** 备用屏的进出：1049 是标准那套，1047 / 47 是旧版写法 */
const ALT_SCREEN_SWITCH = /\x1b\[(?:\?1049|\?1047|\?47)[hl]/g;

/**
 * 这段输出里最后一次切备用屏是不是「切出去」。全屏程序可能来回切（先回主屏打印再进备用屏），
 * 只有停在主屏才该复位。
 */
function leavesAltScreen(chunk: string): boolean {
  let last = "";
  for (const match of chunk.matchAll(ALT_SCREEN_SWITCH)) last = match[0];
  return last.endsWith("l");
}

/**
 * 盯住 PTY 输出里的「切备用屏」，在程序退出（切回主屏）时返回一次 true，调用方据此写
 * TUI_MODE_RESET。
 *
 * 转义序列可能被 PTY 的读取边界切开，所以内部留一块尾巴拼上；输出是字节流，扫描前要解码，
 * 跨块的多字节字符靠 stream 解码器接起来（这份文本只用于扫描，不影响显示）。
 */
export function watchAltScreenExit(): (bytes: Uint8Array) => boolean {
  let tail = "";
  const decoder = new TextDecoder();
  return (bytes) => {
    const scan = tail + decoder.decode(bytes, { stream: true });
    tail = scan.slice(-16);
    return leavesAltScreen(scan);
  };
}
