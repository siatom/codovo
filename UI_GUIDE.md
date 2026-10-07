# UI_GUIDE.md

CodeDock 界面开发规范。**每一条都是踩过坑才定下来的**，动手前对着查一遍；ADR 式的
「为什么」写在条目里，改之前先弄清原因。代码位置以文件为准，行号会漂。

栈：React 19 + TS + Tailwind 4 + Monaco + xterm，外壳 Tauri 2（Windows WebView2 /
macOS WKWebView / Linux WebKitGTK，**三端行为有差异，改前先想跨平台**）。

---

## 一、弹窗与遮罩

**遮罩关框只认「按下点就在遮罩上」，禁止用 `onClick`。**
`click` 会被派发到 mousedown / mouseup 的共同祖先，从弹窗内按下、拖到遮罩上松手也会
被当成「点外部」而误关。统一写法：

```tsx
onMouseDown={(event) => {
  if (event.button === 0 && event.target === event.currentTarget) onCancel();
}}
```

参考 `ConfirmDialog.tsx:58`。**下拉菜单 / 右键菜单不适用这条**——那里没有可拖拽的
输入框，误触概率低，不值得为它改交互。

**关闭路径收敛成三条**：右上角关闭按钮 / 点遮罩 / `Esc`。`Esc` 保留（键盘主动操作
不会误触）；其余路子一律不做。

**不用 `window.confirm` / `prompt` / `alert`。** WKWebView（macOS）不支持 `confirm` /
`prompt`，调用会**静默失效**——不弹框、直接返回，用户不知道发生了什么。破坏性确认一律
自研 `ConfirmDialog`（见 `ConfirmDialog.tsx:31` 的注释）。

**确认框的两条约定**：确认按钮用**动词**（「放弃」「删除」，不是「确定」）并配危险色描边；
`autoFocus` 落在取消按钮上，破坏性操作不该让回车顺手确认掉。

**外壳统一**：遮罩 `fixed inset-0 z-50 bg-black/40` + 卡片 `bg-raised` 圆角 + `shadow-lg`。
AI 产出的长文（改动解读这类）走**居中弹窗**、正文交给 `MarkdownPreview`，不要内联塞进窄面板。

**「点空白处」的判定必须排除 `fixed` 祖先。** 菜单 / 对话框铺的 `fixed inset-0` 透明遮罩，
那一下是先用来关它们的，不能顺手把侧栏 / 右边栏也收掉，否则关个菜单就丢一块布局。走
`lib/dom.ts` 的 `isBlankClick`。

---

## 二、右键菜单

**全局默认屏蔽原生右键菜单**：`main.tsx:16` 在 **document 冒泡阶段**监听 `contextmenu`，
放行 `event.defaultPrevented` 的事件、其余 `preventDefault`。

React 17+ 的事件委托挂在 `#root`、比 document 先跑，所以**自己画菜单的组件先在 handler 里
`preventDefault`**（如 `ExplorerPane.tsx:513`），全局就不重复干预——等价于「只有明确声明了
右键菜单的地方才弹」。**新增右键菜单照这个模式：组件里自己 `preventDefault`，全局不用改。**

**菜单的透明遮罩也要接住右键**（`onContextMenu` 里 `preventDefault` 并关菜单，
`ExplorerPane.tsx:1799`），否则在菜单上再点右键会冒出原生菜单。

**菜单用 `fixed` 定位。** 挂载点是 `overflow-auto` / 横向滚动容器时，绝对定位会被裁掉
（标签栏那个 shell 下拉就是这么定的）。位置按 `event.clientX/clientY` 算。

---

## 三、面板、折叠与显隐

**折叠 = 宽度归零，不卸载。** 右栏收起走 `SplitPane` 的 `secondCollapsed`、全屏走
`firstCollapsed`，都是把宽度压到 0 而不是从树上摘掉——终端的 PTY、Monaco 的撤销历史、
文件树的展开态全靠「组件一直挂着」才留得住（`SplitPane.tsx:11`）。

**同理，内容面板一律 `hidden` / `display:none` 藏着，别条件渲染。** 多工作区、多终端会话、
终端区的 TUI / GUI 两套界面、右边栏各模块，全是这个套路。**注意界面分开 ≠ 卸载**：切走的
那个留在 DOM 里，否则终端的 shell 会被杀。

**「收起」这个词有歧义，先问清。** 「收成一条常驻窄条」和「整块隐藏 + 另给一个显式开关按钮」
是两种东西，别按 VS Code 活动栏的习惯猜。CodeDock 的取向是**后者**：默认只留最核心的视图，
其余按需召唤，开关是一个明确的按钮（右栏的入口是终端工具条最右那个按钮）。

**从隐藏切回可见要补一次 `layout()`**，否则 Monaco 滚不动（隐藏期间容器尺寸是 0，
`EditorPane.tsx:1279`）。

**每个 pane 至少留 `MIN_PCT = 10`**，拖到头也不会把邻居挤没（`use-pane-sizes.ts:9`）。

---

## 四、拖拽与指针

**能吃的指针捕获分两种，别混：**

- **分隔条 / 拖动把手**（1px 细线，不吃点击）→ 用 `setPointerCapture`。指针移出细线后
  照样收得到 `move` / `up`（`SplitPane.tsx:38`）。
- **列表行拖拽重排** → **不要** `setPointerCapture`。捕获会把 `click` 重定向到行容器，
  行内「⋯」「+」这些按钮就全点不动了。做法：按下只记起点，`pointermove` / `pointerup`
  挂 `window`（指针移出行外也收得到），纵向越过 4px 才算拖动，拖完靠 `onClickCapture`
  吞掉浏览器补发的那次 click（`Sidebar.tsx:315`、`Sidebar.tsx:561`）。

**拖动期间给 `body` 挂光标 class**（`codedock-dragging` / `codedock-dragging-row`），
别让指针在拖动中变回去。

**手柄的命中区可以加宽，视觉仍是一条细线**：内嵌一个 `absolute inset-y-0 -left-1 -right-1`
的 `span`（`SplitPane.tsx:91`）。

---

## 五、快捷键

**全部走 `lib/shortcuts.ts` 的命令表**，别处不再拼字面量。`Mod` 是跨平台主修饰键
（macOS ⌘、其余 Ctrl），落盘就这一个写法。判定 / 显示 / 录制都调这里的函数。

**「谁有焦点谁生效」靠 keydown 沿焦点元素祖先链传播实现**，不要加全局监听去分流。
本地终端和远程终端是两个兄弟子树，各在自己容器上挂 keydown——同一个 `Mod+T` 两边不冲突，
天然按焦点路由（`shortcuts.ts:25`）。

**keydown 里的判断要放在「非白名单键 return」之前。** 文件树的复制 / 剪切 / 粘贴是
小写 `c` / `x` / `v`，放后面永远进不来（`ExplorerPane.tsx:1188`）。

**与 shell / 系统语义绑死的键不进这张表**：`Ctrl+C`（SIGINT）、`Ctrl+V`、`Esc` 关闭弹窗，
保留内置，改了会出事。

**正式版屏蔽浏览器快捷键**（F5 / Ctrl+R / Ctrl+P / F12 / Ctrl+Shift+I，`main.tsx:20`），
dev 保留方便调试。

---

## 六、列表与视觉

**默认照 ChatGPT 的克制列表风格**：`rounded-lg`、行高约 34px、行距宽松、**不加边框**，
选中态用**整行底色**（`bg-selected`）而不是描边。工具入口之间用竖排列表切换，不并排、不窄 rail。

**悬停换内容，不是加内容。** 一行只有 200px 出头，时间和操作图标并排会把标题挤没。做法是
两种状态**互斥**：不悬停显示次要信息（时间），悬停时它消失、换成 `⋯` 操作入口
（`Sidebar.tsx:715`）。行内操作按钮用 `opacity-0 group-hover:opacity-100` +
`pointer-events-none group-hover:pointer-events-auto`，**别用 `hidden` 跳宽度**。

**挂在父行下的子列表，左缩进与父名对齐**（如 `pl-[34px]`），不要再往里缩一层。

**不加没有实际功能的元素。** 宁留空也不放装饰性提示 / 假快捷键 / 占位状态——这是刻意的取向，
提方案时不要主动塞「顺带做」的东西。

**图标统一走 `components/icons.tsx`**，具名导出。**唯一例外是文件类型图标**：用彩色品牌图标
（依赖 `simple-icons` 只取路径数据、靠 tree-shaking 控体积）。品牌色偏暗的（markdown / json /
rust 官方色是纯黑）回落 `currentColor`，否则深色主题下看不见。

**就地编辑优于弹输入框**（重命名这类）：`Enter` 确认、`Esc` 取消、`onBlur` 也算确认，
清空 = 取消。

---

## 七、配色与主题

**只用语义色类**（`bg-surface`、`text-fg-muted`、`border-line-strong`…）。新增颜色要同时改
`styles.css` 的 `:root`、`:root[data-theme="light"]`、`@theme` 三处。

**加一套配色要改五处**：`styles.css` 的 `:root[data-palette=...]`、`theme.tsx`
（类型 + `readSavedTheme` 校验 + `resolveTheme` 判明暗）、`SettingsDialog.tsx` 的
`THEME_OPTIONS`、`monaco-setup.ts` 的 `monacoThemeFor` + `palettes`、`terminal-themes.ts` 的
`PALETTE`。

**终端 / Monaco / 界面三处色值必须严格对齐**：background / foreground / cursor / selection
直接取该主题的 `--c-surface` / `--c-fg` / `--c-accent` / `--c-selected`，ANSI 十六色用官方
调色板。**别用 xterm-theme 里近似的 iTerm2 主题做映射**——底色跟界面面板对不上，差一块一眼能看出。

**主题选择是带悬停预览的下拉框**：预览状态在 `ThemeProvider` 里（`preview ?? preference`
决定渲染配色、不写 localStorage），并暴露 `palette` 让终端 / 编辑器一起跟随；移开或关闭即还原，
点到才落盘。

**首帧渲染前先把主题落到 `<html>`**（`main.tsx:10`），否则会先闪一下深色。

**图表 / 泳道这类「只求区分度」的配色独立于语义色**（`--c-graph-1…8`，深浅各一套），不跟主题走。

---

## 八、Monaco 与编辑器

- **hidden 不卸载 + 补 `layout()`**（见第三节）。
- **预览层的内容在渲染期算，按 `activeKey` 从 model 缓存取，绝不读编辑器当前挂着的 model**：
  换 model 的 effect 在渲染之后才跑，从别的文件切到 md 的那一帧读到的是上一个文件的 model，
  而 `isPreview` 由 false→true 只发生这一帧，之后 memo 不重算，错误内容就一直留在预览层上
  （`AGENTS.md` / `EditorPane.tsx:1265`）。这是最隐蔽的一类 bug，改预览逻辑前务必读这段注释。
- 差异编辑器懒创建、只读、不参与脏标记，三种差异靠 model URI 的 scheme 段区分。

---

## 九、状态与持久化

**按作用域分层，别一把塞 localStorage：**

| 级别             | 存储           | 例                                   |
| ---------------- | -------------- | ------------------------------------ |
| 窗口级偏好       | `sessionStorage` | 侧栏折叠、CLI 选择、主机列表宽度   |
| 工作区级         | 按 root 作 key（`sessionStorage`） | 右栏模块、浏览器地址、提交历史视图 |
| 跨窗口共享       | `localStorage` | 设置、主题、工作区列表、远程主机     |

**列表类一律「写前读最新 → 合并去重 → 写」**，直接覆盖会抹掉别处（别的窗口）刚写进去的。
跨窗口靠 `storage` 事件同步（只在**别的** document 触发，不会自回流）。

**后端状态一律按工作区 root 分片**（`FsState` / `WatchState` / `AgentState` / `PtyState`），
命令显式收 `root`；`FsState` 只认登记过的根当白名单。

---

## 十、原生行为与跨平台

- **不用 `window.confirm` / `prompt` / `alert`**（WKWebView 静默失效）。
- **屏蔽原生右键菜单**，见第二节。
- **屏蔽浏览器快捷键**（正式版），见第五节。
- **路径 / 进程 / 快捷键 / 界面行为先想三端差异**。踩过的具体坑：Windows 的 socket 错误文本
  是**本地化中文**，只认英文 `refused` 认不出来，要中英 + Winsock 错误码一起判（`remote.rs`）。

---

## 十一、验证

- 前端改完至少 `pnpm build`（**Vite dev 不做类型检查**）。
- 界面改动走 `scripts/cdp-check.cjs`（WebView2 的 CDP 做截图 / 求值 / 输入），用法见
  `.codebuddy/skills/cdp-verify/`。
  - **要指定窗口传 `"target":"<标题片段>"`**，脚本会跳过 WebView2 内部的 `about:blank`
    target，**别拿 `pages[0]` 当目标**，否则命令全打在空白页上。
  - **拖动必须走 `drag` 而非合成 `PointerEvent`**（应用用 `setPointerCapture`）。
  - 应用起没起来看 9222 端口。
- **`localStorage` 是用户真实状态，验证后必须还原**。测完临时数据（临时主机 / 临时连接 /
  被改的模块选中项）一并回滚。
- **dev 下改工作区内任意文件会触发 HMR 重载**（终端重置、编辑器清空）——这是 dev server
  的产物，不是 bug；用 CodeDock 开发 CodeDock 时记得换工作区，或把测试素材建在
  `node_modules/` 这类被忽略的目录下。

---

## 十二、代码约定（简述）

- 注释一律中文、写「为什么」；反直觉的写法和绕开的坑留一句。
- 组件具名导出（`App.tsx` 例外）、状态用 Context、图标走 `icons.tsx`。
- **只改被要求改的地方**：不重排 import、不改命名、不清理「看起来没用」的代码；宁可重复三行。
- 设置项要动五处：`settings.tsx` → `SettingsDialog.tsx` → 消费方。
- 后端命令 `*.rs` 写 `#[tauri::command]` → `lib.rs` 注册 → 前端 `lib/*.ts` 包一层，
  **组件不直接 `invoke`**。
