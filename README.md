# CodeDock

面向软件开发人员的 AI 编程驾驶舱。左侧是真实终端，右侧是文件浏览与代码编辑。

```
┌────────────────┬────────┬──────────────────────────┐
│                │ 文件树 │                          │
│  终端 (PTY)    │        │   Monaco 编辑器          │
│                │        │                          │
└────────────────┴────────┴──────────────────────────┘
        ↑ 分栏可拖动          ↑ 分栏可拖动
```

## 功能

- **工作区**：启动时自动打开上次用的目录；没有记录（或目录已不存在）就停在空态，等用户选。最左侧是侧边栏：上面是「打开文件夹」，下面「项目」分组列出用过的目录（最近的在最前，当前项高亮），点一个即可切换，终端与文件树一起切过去。每行悬停时右侧出现 `×`，只把这条记录从列表里去掉，**不碰磁盘上的目录**；移掉的正好是当前项目时会顺手清掉启动记录（否则下次启动又被补回来），但本次会话继续开着。左下角是主题切换和设置。侧边栏可收起成一条图标宽的竖条，展开收起时图标只横向挪位、不上下跳。
- **终端**：`portable-pty` + ConPTY 起真实 shell（`pwsh` → `powershell` → `cmd` 自动探测），xterm.js 渲染，支持 WebGL 加速与窗口缩放 reflow。没选工作区时 shell 落在用户主目录。标签栏可新建（`+`）、关闭（`×`）、切换多个会话，每个会话各自一个 PTY，切走的会话仍在后台跑。
- **文件树**：目录懒加载，点击文件在编辑器中打开，可切换工作区目录。以 `.` 开头的隐藏文件和目录照常列出。
- **编辑器**：Monaco（VS Code 内核），离线可用（worker 打包进产物，不走 CDN），按扩展名自动识别语言。同时打开多个文件时排成标签，可切换、关闭（有未保存改动会先确认），`Ctrl+S` 保存当前文件。
- **主题**：深色 / 浅色 / 跟随系统，选择记在 localStorage。终端和 Monaco 各有两套配色跟着一起换。
- **设置**：左下角齿轮打开，存在 `codedock.settings` 一块 JSON 里。目前有主题、终端字体/字号、编辑器字体/字号、AI CLI 命令列表；字体和字号改完立刻生效（终端会重新 fit 并同步行列数给 PTY），字体留空回落到默认等宽栈。
- **AI**：不内置 AI 面板，直接用终端里的 AI CLI。终端工具条上的 `AI CLI` 按钮向当前会话注入命令，默认配了 `claude` 和 `codebuddy` 两个；配了多个时点按钮出下拉选择，只有一个时直接执行。列表在设置里增删。
- **git（只读）**：当前工作区的分支、与上游的 ahead/behind、改动条目数显示在侧边栏项目行下方；文件树每行右侧和编辑器标签页上有状态字母——`M` 黄（改动）、`A`/`U` 绿（新增 / 未跟踪）、`D` 红（删除）、`C` 红（冲突）。**只有读操作**，命令带 `--no-optional-locks`，不会和用户在终端里敲的 git 抢 index 锁。不是仓库、或系统里没有 git 时，这些标记整体消失，其余功能不受影响。

## 开发

```bash
pnpm install
pnpm tauri dev     # 开发（热重载）
pnpm tauri build   # 打包
pnpm build         # 仅前端类型检查 + 构建
cd src-tauri && cargo test --lib   # 后端测试（路径沙箱 + PTY 往返 + git 输出解析）
```

环境：Rust 1.98+、Node 24+、pnpm 11+、WebView2（Windows 10/11 自带）。

### 验证界面（无头）

`scripts/cdp-check.cjs` 通过 WebView2 的 CDP 端口做截图 / 求值 / 模拟输入，用来在不开图形界面的情况下验证界面：

```bash
# 1. 起 vite
pnpm dev
# 2. 带调试端口起应用
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222" ./src-tauri/target/debug/codedock.exe
# 3. 点开某个文件并截图
node scripts/cdp-check.cjs '{"click":[1200,78],"eval":"document.querySelector(".view-lines").innerText","shot":"a.png"}'
```

### 已知 dev 行为

`pnpm tauri dev` 下改动**工作区内任意文件**都会让 Vite 触发一次 HMR 并重载页面（Vite 会把改动误报成 `/src/styles.css`），表现是终端会话被重置、编辑器回到未打开状态。
这是 Vite dev server 的产物，打包后的应用没有 Vite，不受影响。用 CodeDock 开发 CodeDock 本身时建议把工作区切到别的目录。

## 架构

```
src/                      React 前端
  App.tsx                 三段式布局装配 + 工作区/打开文件的状态
  components/
    icons.tsx             统一线条图标（侧边栏、文件树共用）
    SplitPane.tsx         自研可拖动分栏（pointer 事件 + setPointerCapture）
    Sidebar.tsx           侧边栏：项目历史 / 打开文件夹 / 主题切换（可收起成图标条）
    TerminalPane.tsx      终端区：标签栏 + 会话增删切换
    TerminalSession.tsx   单个会话：一个 xterm 实例独占一个 PTY
    ExplorerPane.tsx      文件树状态机（展开 / 懒加载 / 选中）
    FileTreeNode.tsx      递归节点
    EditorPane.tsx        Monaco 包装，复用单个 editor + 多 model 标签
    GitMarkBadge.tsx      文件树与标签页共用的 git 状态字母
    SettingsDialog.tsx    设置面板（主题 / 字号 / AI 命令）
  lib/
    monaco-setup.ts       MonacoEnvironment worker 注册 + 深浅两套主题
    theme.tsx             主题 Context：深/浅/跟随系统，读写 localStorage
    settings.tsx          设置 Context：一块 JSON 存 localStorage，读坏回落默认
    git.ts                useGitStatus：每 2 秒 + 窗口聚焦时轮询当前工作区的 git 状态
    pty.ts / fs.ts        invoke 薄封装；工作区与历史目录存在 localStorage
src-tauri/src/
  pty.rs                  PTY 会话管理
  fs_api.rs               文件读写 + 路径沙箱（未选工作区时全部拒绝）
  git.rs                  只读 git 状态（调用系统 git CLI）
  lib.rs                  state / command 注册 / 退出回收
```

### 几个关键实现决定

- **PTY 输出走 base64，不在后端解码**。`read()` 会把多字节 UTF-8 从中间截断，后端一旦 decode 就产生乱码。后端只搬运字节，由前端 xterm 自己拼接跨 chunk 的序列。
- **输出走 `Channel<PtyEvent>` 而非全局事件名**。避免动态事件名，也避免多终端实例串台。
- **文件路径一律经词法归一化 + 前缀校验**。目标不存在时 `canonicalize` 会失败，所以创建类操作靠词法归一化挡 `..`，已存在的路径再走 `canonicalize` 挡软链接逃逸。越界直接报错。
- **Monaco worker 用 Vite `?worker` 内联**，`monaco-editor` 的 exports map 是 `"./*" -> "./esm/vs/*.js"`，导入路径不能再带 `esm/vs` 前缀。
- **终端容器不设 padding**：FitAddon 只扣 xterm 自身 padding，不扣父元素的，父元素留 padding 会导致列数算多。
- **终端容器必须 `overflow-clip`**：输入法合成时 xterm 的 `.composition-view` 按光标位置画，光标靠右时会伸出行尾。浏览器为了让这个"焦点附近"的内容可见，会横向滚动最近的可滚动祖先——分栏面板虽然写着 `overflow: hidden`，照样能被程序滚动，于是整块终端被推左、合成结束再弹回，表现就是打汉字时屏幕左右抖。用 `clip` 而不是 `hidden`，因为 `clip` 连程序滚动都不允许。代价是超出右边缘的合成文字会被裁掉一点。
- **React StrictMode 下的 PTY 竞态**：effect 会在首次挂载后立刻重跑一次，若 spawn 的 `await` 尚未返回，清理逻辑拿不到 handle，必须用 `cancelled` 标记在 await 之后补一次 `kill`，否则会留下两个 shell。同一个标记也用来丢弃作废会话的 `Exit` 事件，否则第一次挂载的会话退出后会把「shell 已退出」打到存活的界面上。
- **切换工作区必须前后端一起换**。后端 `fs_set_root` 决定文件读写的沙箱边界，前端 state 决定界面渲染；只改前端会让后端拿旧根目录去校验新路径，直接报"路径越界"。切换后终端靠 `key` 重建（见下条），文件树则要丢弃在途的旧请求，否则旧工作区返回的错误会盖到刚加载好的新目录上。
- **切换工作区靠重开 shell，不往运行中的 shell 塞 `cd`**：跨盘符、不同 shell 的转义规则都不一样，重开是唯一确定的做法（代价是丢掉滚动历史和正在跑的 AI CLI 会话）。多会话下同理，换工作区时整个终端区连同所有标签一起重建。
- **非当前会话用 `display:none` 藏起来而不是卸载**：卸载会杀掉 shell，切回来历史就没了。代价是藏起来的会话量不到尺寸（FitAddon 会算成 0），所以切回来那一帧要补一次 `fit()` 并把新的 cols/rows 同步给 PTY。
- **git 状态走 `status --porcelain=v2 --branch -z`**。v2 的 XY 两列分别给出暂存区和工作区状态，比 v1 好判断；`-z` 让路径不做引号转义，空格和中文原样拿到，省掉一整套反解析（也因此不用管 `core.quotepath`）。`-z` 下重命名记录后面还跟着一条原路径，解析时必须一并吞掉。
- **工作区可能只是仓库的一个子目录**：先跑 `rev-parse --show-prefix`，一次调用同时回答"是不是仓库"和"工作区在仓库里的位置"，再用它把仓库级的条目折算成工作区内的绝对路径（前缀带尾斜杠，`sub/` 不会误伤 `subber.txt`）。
- **未跟踪目录按 `--untracked-files=normal` 整条折叠**：否则刚 clone 下来、`.gitignore` 还没写的仓库会吐出几万条，2 秒一轮的 IPC 直接被打爆。折叠后目录本身带 `U` 标记，展开的子文件不再单独标。
- **git 子命令一律 `--no-optional-locks`**：轮询用的 status 不该抢 `index.lock`，把用户自己在终端里敲的 git 命令挡在门外。
- **Windows 上起 git 必须带 `CREATE_NO_WINDOW`**：否则每 2 秒闪一个控制台黑框。
- **git 状态查询只读且容错**：非仓库时返回 `isRepo: false`（属于正常结果，界面整体隐藏标记）；git 没装或超时才返回错误，前端据此**停掉轮询**，免得每 2 秒白起一个进程。上一次请求没回来就跳过这一轮，慢仓库不会把请求堆起来。

## 快捷键

| 快捷键 | 作用 |
| --- | --- |
| `Ctrl+S` | 保存当前文件 |
