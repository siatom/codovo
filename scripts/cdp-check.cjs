// 通过 CDP 连到 WebView2，做截图 / 求值 / 模拟按键，用于验证界面真的能用。
// 用法: node scripts/cdp-check.cjs '{"wait":1500,"keys":"git status\r","shot":"a.png","eval":"..."}'
// 多窗口：加 "target":"工作区名" 按窗口标题挑一个（App 把标题设成 `CodeDock — <工作区名>`）；
// 不传就取第一个 page。
const http = require("node:http");
const fs = require("node:fs");

const getJson = (url) =>
  new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve(JSON.parse(body)));
      })
      .on("error", reject);
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function keyFor(ch) {
  if (ch === "\r") {
    return { key: "Enter", code: "Enter", vk: 13, text: "\r" };
  }
  if (ch === " ") {
    return { key: " ", code: "Space", vk: 32, text: " " };
  }
  const upper = ch.toUpperCase();
  const isLetter = /[a-z]/i.test(ch);
  return {
    key: ch,
    code: isLetter ? `Key${upper}` : "",
    vk: upper.charCodeAt(0),
    text: ch,
  };
}

async function main() {
  const options = JSON.parse(process.argv[2] ?? "{}");
  const port = options.port ?? process.env.CDP_PORT ?? 9222;
  // 多窗口下会有多个 page 目标：按标题 / URL 挑一个，不传就取第一个
  const target = options.target ?? "";
  const targets = await getJson(`http://127.0.0.1:${port}/json`);
  const pages = targets.filter((t) => t.type === "page");
  // WebView2 会挂一个 about:blank 的内部 target，别让它在默认位抢了真实窗口
  const usable = pages.filter((t) => (t.url ?? "") !== "about:blank");
  const pool = usable.length > 0 ? usable : pages;
  const page = target
    ? pool.find(
        (t) => (t.title ?? "").includes(target) || (t.url ?? "").includes(target),
      )
    : pool[0];
  if (!page) {
    throw new Error(
      target
        ? `没有匹配 target=${JSON.stringify(target)} 的窗口，当前有：${pages
            .map((t) => t.title)
            .join(" / ")}`
        : "没有找到 page 目标",
    );
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map();

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  });

  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  await send("Runtime.enable");
  await sleep(options.wait ?? 800);

  // 直通任意 CDP 命令，用来模拟浏览器层面的事件（如 Emulation.setEmulatedMedia 改系统主题）
  if (options.cdp) {
    console.log("CDP:", JSON.stringify(await send(options.cdp.method, options.cdp.params ?? {})));
  }

  if (options.focus !== false) {
    await send("Runtime.evaluate", {
      expression: `document.querySelector(${JSON.stringify(
        options.focusSelector ?? ".xterm-helper-textarea",
      )})?.focus()`,
    });
  }

  if (options.keys) {
    for (const ch of options.keys) {
      const { key, code, vk, text } = keyFor(ch);
      await send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key,
        code,
        windowsVirtualKeyCode: vk,
        nativeVirtualKeyCode: vk,
        text,
        unmodifiedText: text,
      });
      await send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key,
        code,
        windowsVirtualKeyCode: vk,
        nativeVirtualKeyCode: vk,
      });
      await sleep(20);
    }
    await sleep(options.afterKeys ?? 1200);
  }

  if (options.click) {
    const [x, y] = options.click;
    const base = { x, y, button: "left", clickCount: 1, buttons: 1 };
    await send("Input.dispatchMouseEvent", { type: "mousePressed", ...base });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base, buttons: 0 });
    await sleep(options.afterClick ?? 400);
  }

  // 拖拽：必须走 CDP 派发真实指针事件。应用里的拖动都用 setPointerCapture，
  // 合成的 PointerEvent 没有对应的活动指针，捕获那一步会直接抛 NotFoundError
  if (options.drag) {
    const [x1, y1, x2, y2] = options.drag;
    const steps = options.dragSteps ?? 10;
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: x1,
      y: y1,
      button: "left",
      clickCount: 1,
      buttons: 1,
    });
    for (let step = 1; step <= steps; step += 1) {
      await send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: Math.round(x1 + ((x2 - x1) * step) / steps),
        y: Math.round(y1 + ((y2 - y1) * step) / steps),
        button: "left",
        buttons: 1,
      });
      await sleep(16);
    }
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: x2,
      y: y2,
      button: "left",
      clickCount: 1,
      buttons: 0,
    });
    await sleep(options.afterDrag ?? 400);
  }

  if (options.insertText) {
    // Monaco 的 textarea 会忽略合成的 keydown，用 insertText 走真实输入管线
    await send("Input.insertText", { text: options.insertText });
    await sleep(options.afterKeys ?? 1000);
  }

  if (options.ctrlKey) {
    const { key, code, vk } = keyFor(options.ctrlKey);
    const base = {
      key,
      code,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
      modifiers: 2, // Ctrl
    };
    await send("Input.dispatchKeyEvent", { type: "keyDown", ...base, text: "", unmodifiedText: "" });
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    await sleep(options.afterCtrl ?? 1500);
  }

  if (options.eval) {
    const result = await send("Runtime.evaluate", {
      expression: options.eval,
      returnByValue: true,
      awaitPromise: true,
    });
    console.log("EVAL:", JSON.stringify(result.result?.value ?? result, null, 2));
  }

  if (options.shot) {
    const shot = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(options.shot, Buffer.from(shot.data, "base64"));
    console.log("SHOT:", options.shot);
  }

  ws.close();
}

main().catch((error) => {
  console.error("FAILED:", error.message);
  process.exit(1);
});
