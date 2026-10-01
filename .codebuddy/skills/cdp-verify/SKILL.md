---
name: cdp-verify
description: >-
  用 WebView2 的 CDP 驱动正在运行的 CodeDock 做界面验证——截图、求值、模拟按键 / 点击 / 拖拽，
  确认改动能真跑通，而不是只看代码。当需要验证界面改动、复现 UI 交互（切工作区、拖面板、敲终端、
  编辑 Monaco、看主题）或检查应用起没起来时使用。脚本是 scripts/cdp-check.cjs，本技能只说怎么用它。
  仅 Windows 可用（macOS 的 WKWebView / Linux 的 WebKitGTK 没有这套 CDP 端口）。
---

# CDP 界面验证

`scripts/cdp-check.cjs` 连到运行中应用的 WebView2 调试端口，用 CDP 派发真实输入并回读结果。
**它验证的是「界面真的能用」，不是「代码看起来对」。** 本技能不重复脚本，只讲清楚前提、选项和坑。

## 1. 前提：只有 Windows，且先有带 CDP 的 dev

**平台**：WebView2 才有 CDP 端口。macOS 是 WKWebView、Linux 是 WebKitGTK，脚本在这两端跑不通——
改界面要么换回 Windows 验证，要么用各平台自带开发者工具。

**脚本只连「已经在跑」的应用**：先按 1a 探有没有现成的带 CDP 实例，有就复用，没有才按 1b 启动
（启动细节见 `/dev-local`）。

### 1a. 启动前先探：已经有带 CDP 的 dev 就复用，别再起

**别上来就启动。** 同 identifier 的 dev 受 `tauri-plugin-single-instance` 约束：再起一个不会新开窗口、
只会把现有的唤到前台。所以现有那个要是没带 CDP，新起的这次等于白起。启动前先看有没有现成的：

```bash
# ① 9222 有没有在听 ② 听的是不是 CodeDock dev（dev 窗口加载的是 devUrl: localhost:5273）
netstat -ano | grep ":9222" | grep -i LISTENING \
  && curl -s http://127.0.0.1:9222/json | grep -o '"url": *"[^"]*"'
```

- **列出了 `localhost:5273` 的 page** → 现有实例就带 CDP，**直接复用，跳到第 2 节**，别再启动。
- **9222 没在听（命令没输出）** → 没有可用实例，按 1b 起一个。
- **9222 在听、但里面没有 CodeDock 的 page** → 端口被别的程序占了，按 1b 换端口起。

> 若 5273（vite）已被占、9222 却没开，多半是上一个**没带 CDP** 的 dev 还开着（旧版本起的）。交给
> `/dev-local` 处理即可：它启动前会探测到那个 dev，**用 AskUserQuestion 问用户是否关闭**，同意才关掉重起
> （`/dev-local` Windows 上固定带 CDP，所以重起后 9222 就在了）。**退出 dev 实例是安全的；唯一别动的是
> 安装版**（见 1c）。别自己去点关闭按钮——dev 的关窗口只会把它收进托盘、进程还在，反而挡住重起。

### 1b. 没有现成实例时，按 `/dev-local` 启动

**Windows 上 `/dev-local` 启动的 dev 默认就带 CDP**（`--remote-debugging-port=9222`），直接照它的 1b
启动即可，**不用再自己拼环境变量**。做法是 `scripts/dev-local.sh` 包一层（它顺带做退出清场），别直接
`nohup pnpm tauri dev`——完整步骤见 `/dev-local`。

端口被别的东西占了就换：启动时显式覆盖端口，之后调脚本带上对应的 `port`：

```
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223" nohup bash scripts/dev-local.sh > "$TEMP/codedock-dev.log" 2>&1 &
# 调脚本时：node scripts/cdp-check.cjs '{"port":"9223","shot":"ui.png"}'
```

### 1c. 检查应用起没起（**不要关安装版**）

- **安装版和 dev 天然并存，别去动它**：两者 identifier 不同——安装版是 `com.codedock`，dev 由
  `build.rs` 在 debug profile 下 patch 成 `com.codedock.dev`。WebView2 的 user data folder 按
  identifier 分开，各跑各的 browser 进程，互不干扰；9222 只属于 dev 那一组，安装版开着照样监听。
  所以**看到安装版在跑不要 taskkill，也不要叫用户关**——它是用户的真实实例，可能压着没保存的
  状态和正在跑的会话。
- **应用真的起来了**：看 9222 是否在监听——`netstat -ano | grep ":9222" | grep LISTENING`。
  脚本报「没有找到 page 目标」基本就是 dev 没起、或 dev 不是经 `/dev-local` 起的（它才带 CDP 参数）。

## 2. 用法

脚本收**一个 JSON 参数**，键都是可选的：

```
node scripts/cdp-check.cjs '{"wait":1500,"target":"CodeDock","keys":"git status\r","shot":"a.png"}'
```

按需组合下面的键，脚本按固定顺序执行：`cdp` → `focus` → `keys` → `click` → `drag` →
`insertText` → `ctrlKey` → `eval` → `shot`。输出是 `CDP:` / `EVAL:` / `SHOT:` 三行。

| 键 | 作用 | 默认 |
|---|---|---|
| `port` | CDP 端口 | `$CDP_PORT` 或 `9222` |
| `target` | 按窗口标题 / URL 子串挑窗口 | 取第一个 page |
| `wait` | 开跑前的等待 | `800` |
| `cdp` | 直通任意 CDP 命令，`{method,params}`（如 `Emulation.setEmulatedMedia` 改系统主题） | — |
| `focus` / `focusSelector` | 是否先聚焦、聚焦谁 | `true` / `.xterm-helper-textarea` |
| `keys` | 逐字符模拟按键（`\r`=回车、空格可用） | — |
| `afterKeys` | 按键后等待 | `1200` |
| `click` | `[x,y]` 点一下 | — |
| `drag` | `[x1,y1,x2,y2]` 拖拽 | — |
| `dragSteps` / `afterDrag` | 拖拽步数 / 后等待 | `10` / `400` |
| `insertText` | 走真实输入管线插文本（Monaco 用这个，合成 keydown 它不认） | — |
| `ctrlKey` | 单字符，按住 Ctrl 敲（如 `ctrlKey:"k"`） | — |
| `afterCtrl` | Ctrl 快捷键后等待 | `1500` |
| `eval` | 求值表达式，`returnByValue` + `awaitPromise`，结果打 `EVAL:` | — |
| `shot` | 截图存 PNG，打 `SHOT:` | — |

## 3. 关键坑（都踩过，别绕回去）

- **`target` 认的是窗口标题**：App 把标题设成 `CodeDock — <工作区名>`，多工作区 / 多窗口时按工作区名挑。
  不传就取第一个 page。
- **别拿 `pages[0]` 当目标**：WebView2 会挂一个 `about:blank` 的内部 target，脚本已过滤掉它，
  你手动用其它工具时也要跳过，否则命令全打在空白页上。
- **拖拽必须走 `drag`**：应用里的拖动都用 `setPointerCapture`，合成 `PointerEvent` 没有对应活动指针，
  捕获那步直接抛 `NotFoundError`。所以脚本用 CDP `Input.dispatchMouseEvent` 派发真实指针事件，
  别改成 `eval` 里造事件。
- **Monaco 用 `insertText`**：它的 textarea 忽略合成 keydown，只有 `Input.insertText` 走得到输入管线。
- **`localStorage` 是用户真实状态**：验证时改过的项（主题、工作区列表、别名…）**验证完要还原**，
  否则污染用户环境。
- **别在这上面改工作区文件**：dev 下改工作区内任意文件会触发 HMR 重载（终端重置、编辑器清空），
  是 dev server 产物。用 CodeDock 开发 CodeDock 时先换个工作区。

## 4. 常用配方

```bash
# 截图看当前界面
node scripts/cdp-check.cjs '{"shot":"ui.png"}'

# 多窗口里挑「某工作区」那个窗口
node scripts/cdp-check.cjs '{"target":"我的工作区","shot":"proj.png"}'

# 在终端敲命令并回读
node scripts/cdp-check.cjs '{"keys":"git status\r","shot":"term.png"}'

# 求值看状态（拿 DOM / 全局变量）
node scripts/cdp-check.cjs '{"eval":"document.querySelectorAll(\".tab\").length"}'

# 拖右侧面板分隔条（坐标按截图量）
node scripts/cdp-check.cjs '{"drag":[1200,300,900,300],"shot":"after-drag.png"}'

# 模拟系统深色主题
node scripts/cdp-check.cjs '{"cdp":{"method":"Emulation.setEmulatedMedia","params":{"features":[{"name":"prefers-color-scheme","value":"dark"}]}},"shot":"dark.png"}'
```

## 5. 排障

| 症状 | 原因 / 处理 |
|---|---|
| `没有找到 page 目标` | 应用没起，或 9222 没开。先查 `netstat -ano \| grep ":9222"`；没监听多半是 dev 不是经 `/dev-local` 起的（它才带 CDP 参数），按 1b 重起 |
| `没有匹配 target=...` 的窗口 | `target` 子串写错；报错里会列出当前所有窗口标题，照抄一个 |
| 命令全打在空白页 | 目标选到了 about:blank 内部 target，用 `target` 指定真实窗口 |
| 拖拽抛 `NotFoundError` | 用了合成 PointerEvent，改走 `drag` |
| Monaco 里输入没反应 | 用了 `keys`，改成 `insertText` |
| 连不上、9222 没监听，且日志里有 `WEBVIEW2` 报错 | user data folder 被占。**仍不要动安装版**，给 dev 单独指一个目录再起（`WEBVIEW2_USER_DATA_FOLDER=...`） |
