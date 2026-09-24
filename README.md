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
- **终端**：`portable-pty` + ConPTY 起真实 shell（`pwsh` → `powershell` → `cmd` 自动探测），xterm.js 渲染，支持 WebGL 加速与窗口缩放 reflow。没选工作区时 shell 落在用户主目录。标签栏可新建（`+`）、关闭（`×`）、切换多个会话，每个会话各自一个 PTY，切走的会话仍在后台跑。工具条最右边那个按钮负责展开/收起右边栏。
- **文件树**：在右边栏的「文件」模块里，目录懒加载，点击文件在编辑器中打开，可切换工作区目录。以 `.` 开头的隐藏文件和目录照常列出。头部有「新建文件」「新建文件夹」两个按钮：在树里就地长出一个输入框，`Enter` 建好、`Esc` 取消，重名或名字非法就地把错误显示出来、输入不丢。建在哪儿看当前选中的那一行——选中目录就建在目录里，选中文件就建在它旁边，什么都没选就建在工作区根；**点目录也算选中它**（和 VS Code 一样，选中和展开是同一次点击）。目录结构由后端监听，别的程序（终端、git、另一个编辑器）改了工作区，文件树会自己跟着刷新，不用手点刷新按钮。头部还有个搜索按钮：点开变成输入框，按文件名做大小写不敏感的子串匹配（`Esc` 或 `✕` 关闭），结果是**就地过滤文件树**——只留通往命中项的目录并把它们展开，不是另开一个结果列表。搜索由后端递归遍历整个工作区完成，会跳过 `node_modules` / `.git` / `target` / `.venv` / `__pycache__` 等目录，并且有 300 条结果、10 万次目录项的上限。
- **编辑器**：在右边栏的右半边，Monaco（VS Code 内核），离线可用（worker 打包进产物，不走 CDN），按扩展名自动识别语言。同时打开多个文件时排成标签，可切换、关闭（有未保存改动会先确认），`Ctrl+S` 保存当前文件。
- **主题**：深色 / 浅色 / 跟随系统，选择记在 localStorage。终端和 Monaco 各有两套配色跟着一起换。
- **设置**：左下角齿轮打开，存在 `codedock.settings` 一块 JSON 里。目前有主题、终端字体/字号、编辑器字体/字号、AI CLI 命令列表；字体和字号改完立刻生效（终端会重新 fit 并同步行列数给 PTY），字体留空回落到默认等宽栈。
- **AI**：不内置 AI 面板，直接用终端里的 AI CLI。终端工具条上的 `AI CLI` 按钮向当前会话注入命令，默认配了 `claude` 和 `codebuddy` 两个；配了多个时点按钮出下拉选择，只有一个时直接执行。列表在设置里增删。
- **git**：当前工作区的分支、与上游的 ahead/behind、改动条目数显示在侧边栏项目行下方；文件树每行右侧和编辑器标签页上有状态字母——`M` 黄（改动）、`A`/`U` 绿（新增 / 未跟踪）、`D` 红（删除）、`C` 红（冲突）。打开时只有侧边栏 + 终端两栏：**右边栏（文件/变更 + 编辑器）默认收起**，点终端右上角那个按钮才展开。展开后是 [图标条 | 模块内容 | 编辑器]，图标条切换「文件」/「变更」，点「变更」就是改动管理：提交信息框（`Ctrl+Enter` 提交）+「暂存的改动」/「改动」两个列表，每行悬停出现 `+`/`−` 暂存或取消暂存，两个分组标题右侧各有「全部暂存」/「全部取消」。点改动项在编辑器里打开的是**差异视图**（内联、只读，标签上带 `↔ index` / `↔ HEAD` 后缀），基线照 VS Code——「改动」组比 index，「暂存的改动」组比 HEAD；未跟踪文件基线为空、被删文件当前侧为空。面板底部还有一个可折叠的**提交历史**（短 hash + 提交信息，悬停看作者和时间），点一条就展开它改过的文件、点文件打开「该提交 vs 它的父提交」的差异（标签上是 `↔ <短 hash>^`）；展开时**拖它的上边缘能改高度**（拖动条在收起状态下不画——没有东西可调）。目录不是 git 仓库时图标条里的「变更」置灰不可点，界面停在「文件」。收起只是把右边栏裁掉、并不卸载，所以文件树的展开态、提交草稿、Monaco 的撤销历史都留得住。只读查询带 `--no-optional-locks`，不会和用户在终端里敲的 git 抢 index 锁。不是仓库、或系统里没有 git 时，这些标记整体消失，其余功能不受影响。
- **git 不做的事**：丢弃改动、reset、push/pull/fetch、分支切换、在两个提交之间任意对比（只能看「提交 vs 父提交」）。工作区里嵌套的子仓库也不会被单独识别。

## 开发

```bash
pnpm install
pnpm tauri dev     # 开发（热重载）
pnpm tauri build   # 打包
pnpm build         # 仅前端类型检查 + 构建
cd src-tauri && cargo test --lib   # 后端测试（路径沙箱 + PTY 往返 + git 输出解析与暂存/提交）
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

能做的动作：`keys`（逐字符敲）、`insertText`（走真实输入管线，Monaco 用这个）、`click`（单次点击）、`drag: [x1,y1,x2,y2]`（拖拽，会派发一串真实的 mousePressed/mouseMoved/mouseReleased）、`ctrlKey`、`cdp`（直通任意 CDP 命令）。

拖动一定要走 `drag` 而不是在 `eval` 里合成 PointerEvent：应用里的拖动都用 `setPointerCapture`，合成事件没有对应的活动指针，捕获那一步会直接抛 `NotFoundError`。

### 已知 dev 行为

`pnpm tauri dev` 下改动**工作区内任意文件**都会让 Vite 触发一次 HMR 并重载页面（Vite 会把改动误报成 `/src/styles.css`），表现是终端会话被重置、编辑器回到未打开状态。
这是 Vite dev server 的产物，打包后的应用没有 Vite，不受影响。用 CodeDock 开发 CodeDock 本身时建议把工作区切到别的目录。

## 架构

```
src/                      React 前端
  App.tsx                 三段式布局装配 + 工作区/打开文件的状态
  components/
    icons.tsx             统一线条图标（侧边栏、文件树共用）
    SplitPane.tsx         自研可拖动分栏（pointer 事件 + setPointerCapture，支持收起第二块）
    Sidebar.tsx           侧边栏：项目历史 / 打开文件夹 / 主题切换（可收起成图标条）
    WorkspaceEmpty.tsx    还没选工作区时的空态（选文件夹，或显示上次那个目录为什么打不开）
    TerminalPane.tsx      终端区：标签栏 + 会话增删切换
    TerminalSession.tsx   单个会话：一个 xterm 实例独占一个 PTY
    ExplorerPane.tsx      文件树状态机（展开 / 懒加载 / 选中）
    FileTreeNode.tsx      递归节点
    EditorPane.tsx        Monaco 包装：复用单个 editor + 多 model 标签，另有只读的内联 DiffEditor 和 markdown 预览层
    MarkdownPreview.tsx   markdown 预览层：只读 HTML + 拦掉链接跳转，排版样式在 styles.css 的 .markdown-body
    GitMarkBadge.tsx      文件树与标签页共用的 git 状态字母
    ToolRail.tsx          右边栏最左侧的图标条（44px）：切换文件 / 变更 / 浏览器
    ToolPane.tsx          右边栏各模块的内容容器（文件树 / 变更 / 浏览器），常挂载只切显隐
    GitChangesPane.tsx    「变更」模块：改动列表 + 提交框 + 暂存/取消暂存
    BrowserPane.tsx       「浏览器」模块：iframe 内嵌本地服务，地址栏补全片段 + 刷新即重挂
    FullscreenButton.tsx  三个模块标题栏右端共用的全屏开关（铺满窗口，侧边栏和终端让位）
    SettingsDialog.tsx    设置面板：左侧竖排 tab（外观 / 终端 / 编辑器），固定尺寸、滚到两端翻页
  lib/
    monaco-setup.ts       MonacoEnvironment worker 注册 + 深浅两套主题
    languages.ts          按扩展名 / 文件名映射 Monaco 的语言 id
    markdown.ts           marked + DOMPurify 渲染（预览用；不做代码高亮）
    theme.tsx             主题 Context：深/浅/跟随系统，读写 localStorage
    settings.tsx          设置 Context：一块 JSON 存 localStorage，读坏回落默认
    terminal-themes.ts    终端配色：内置深浅两套 + xterm-theme 常用主题清单 + 解析函数
    git.ts                useGitStatus：轮询 git 状态 + 写操作后的状态落地
    tabs.ts               编辑器标签的身份：普通文件 / 差异视图，以及 tabKey / sameTab
    types.ts              前后端共享的类型（FileEntry / GitFileStatus / PtyEvent）
    pty.ts / fs.ts        invoke 薄封装（含 fs_search_files）；工作区与历史目录存在 localStorage
src-tauri/src/
  pty.rs                  PTY 会话管理
  fs_api.rs               文件读写/新建 + 路径沙箱（未选工作区时全部拒绝）+ 按文件名递归搜索
  watcher.rs              工作区目录监听：防抖后把「哪个目录变了」推给前端
  git.rs                  git 状态查询、暂存/提交、提交历史与差异内容（调用系统 git CLI）
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
- **git 子命令一律 `--no-optional-locks`**：轮询用的 status 不该抢 `index.lock`，把用户自己在终端里敲的 git 命令挡在门外。**写操作反过来不带它**——该抢锁就抢，抢不到时把 git 的报错透传给用户，比静默乱写正确。
- **Windows 上起 git 必须带 `CREATE_NO_WINDOW`**：否则每 2 秒闪一个控制台黑框。
- **git 状态查询只读且容错**：非仓库时返回 `isRepo: false`（属于正常结果，界面整体隐藏标记）；git 没装或超时才返回错误，前端据此**停掉轮询**，免得每 2 秒白起一个进程。上一次请求没回来就跳过这一轮，慢仓库不会把请求堆起来。
- **暂存/取消暂存要 `--literal-pathspecs`**：git 的 pathspec 会把 `*` `?` `[` 当通配符，文件名里带这些字符时会被匹配到别的文件上去。这个全局选项一次性关掉 glob 和 `:(...)` 魔法，但**必须排在子命令之前**，放到后面会被当成一个 pathspec。
- **"全部暂存"必须显式给 pathspec `.`**：工作区可能只是仓库的一个子目录，不带 pathspec 的 `git add -A` 会把**整个仓库**都暂存了，界面上根本看不出来。
- **还没有提交的仓库里取消暂存得换一条命令**：`git restore --staged` 在没有 HEAD 时会 `could not resolve HEAD` 直接失败，这时改用 `git rm --cached`（只摘 index，不碰工作区文件）。反过来也不能一律用它——有 HEAD 时它会把"未暂存的修改"变成"已暂存的删除 + 未跟踪"，语义完全错。判定用 `rev-parse --verify --quiet HEAD`，不要去解析 stderr 文案（会随 git 版本和语言环境变）。
- **`resolve` 对"路径还不存在"要一路向上找**：git 会报出整个目录被删后的 `dir/a.txt`，那时 `dir` 已经不存在了，坚持"父目录必须存在"会让删除类改动完全没法暂存。安全性不变——存在的那一段照样 canonicalize，软链接逃逸还是被挡在外面。
- **写命令把新的 `GitStatus` 直接带回来**：一次 IPC 完成"写 + 刷新"，界面没有等下一个轮询周期的空窗。同时前端用一个 busy 标志禁用所有写按钮，避免自己和自己抢 `index.lock`。
- **git 的报错要整段回传**：没配 `user.name` 时 git 会吐一大段带修复命令的多行 stderr，截成一行反而没用。前端用 `whitespace-pre-wrap` 原样展示。
- **文件名搜索是"后端遍历 + 前端拼树"**：文件树是懒加载的，只过滤已加载的节点等于搜不到没展开过的目录，所以遍历必须放后端（`fs_search_files`）。后端只回一串命中文件的绝对路径；前端按这些路径把祖先目录合成出来（分隔符直接读 `路径[root.length]` 那一位，不猜），所以过滤时一次 `listDir` 都不用发，命中路径的展开态也天然是全展开。写入侧用 `to_lowercase().contains()` 做大小写不敏感的子串匹配，只匹配文件名、不匹配目录也不匹配整条相对路径。
- **搜索必须跳过重目录**：`node_modules` / `.git` / `target` / `.venv` / `__pycache__` 这些动辄几万个文件，不跳过的话一次搜索就能把界面卡住（本项目自己的 `target` 就有 5.8G）。除此之外还设了 300 条结果和 10 万次目录项两道上限，结果排序后返回，保证同样的查询给出同样的顺序。遍历用显式栈而不是递归，且 `file_type()` 是 lstat 语义，指向外部的软链接目录不会被走下去（顺带挡掉循环链接）。
- **目录监听只发"哪个目录变了"，不发文件详情**：前端自己决定要不要重新列。发文件详情等于把文件树的模型搬到后端，还得处理它没展开过的目录；发目录路径则天然匹配懒加载——没展开过的目录前端直接忽略，展开时本来就会去读最新的。载荷是**父目录**（新建/删除影响的是它所在的那一层），`Create`/`Remove`/重命名都在内，纯内容改动不算——否则编辑器每存一次盘就要刷一遍树。
- **监听要防抖，还要跳过重目录**：解包、切分支、`cargo build` 会连着打出成百上千个事件，不攒够 300ms 就发会把 IPC 打爆；而文件树要的只是"最终长什么样"，中间态没有意义。`node_modules` / `target` 这些目录**里面**的变化一律丢弃（和搜索共用一份 `SKIP_DIRS`），但重目录**自己**被建出来时要放行，否则用户新建一个 `dist` 会在树里凭空消失。判定方式是"相对路径去掉最后一段后还剩不剩重目录名"。
- **监听在 `fs_set_root` 里换，失败也不阻断切换工作区**：换工作区必须先停掉旧的（丢掉 `RecommendedWatcher` 就停了，再让防抖线程收到退出信号），否则旧目录上的事件会继续发给已经切过去的界面。监听起不来只影响"自动刷新"这一个便利功能，用户还有刷新按钮，不值得把整个切换失败掉。
- **差异视图的基线取法照 VS Code**：暂存的改动比 `HEAD ↔ index`，未暂存的改动比 `index ↔ 工作区`。两侧内容都由后端一次给全（`git cat-file blob`），前端不自己去读工作区文件——被删除的文件从磁盘上根本读不到，交给 git 更稳。取内容前先 `git cat-file -s` 问大小，`cat-file blob` 会把整个对象读进内存，大文件必须提前挡住。
- **`cat-file` 的路径是相对仓库根的，工作区却可能只是仓库的子目录**：所以要先 `rev-parse --show-prefix` 拿到前缀再拼（pathspec 那套"相对工作区"的写法在这里不能用）。`rev-parse --show-prefix` 非 0 退出同时回答了"不是仓库"，正好复用。
- **两侧内容统一按 LF 比较**：本机 `core.autocrlf=true`，index 存 LF、工作区常是 CRLF，不归一就会出现"整个文件都改了"的假差异。归一后的行为和 `git diff` 一致——只改行尾本来也不该显示。
- **差异标签的 model 用独立 scheme（`codedock-diff:`）**：同一个文件可能既被当普通文件打开、又被当差异打开，复用 `monaco.Uri.file(path)` 会让两个 model 撞在一起。差异的 model 成对存在另一个 Map 里，和 `modelsRef` 彻底分开——这是"只读"的结构性保证：自动保存遍历的永远是 `modelsRef`，压根看不到差异的 model。
- **差异编辑器懒创建**：第一次真的要看差异时才 `createDiffEditor`，避免在 hidden（0 尺寸）的容器上建实例；`hidden → 可见` 切换后补一次 `layout()`（和 markdown 预览同一套路）。
- **差异视图是只读的**：`readOnly` + `originalEditable: false`，且差异标签不参与脏标记、不显示保存按钮、不显示 markdown 预览按钮，`Ctrl+S` 对它无反应。
- **差异视图已知局限**：不随 git 轮询自动刷新（暂存/还原后基线会过期，切回该标签会重拉）；重命名只报新路径，基线退化成"整文件新增"。
- **提交历史用 `git log --format=...%x00` 取**：字段之间用 `%x1f`、每条记录以 `%x00` 结尾。作者名和提交信息都可能带空格，拿空格或换行当分隔符都要额外转义；NUL 不可能出现在 git 的文本字段里，切起来最稳。提交时间取 `%at`（Unix 秒），界面自己折算成"多久前"。
- **提交里改了哪些文件用 `show --name-status -z`**：`-z` 下是 `<状态>\0<路径>\0` 交替出现，重命名/复制多一个 token（`<R100>\0<原路径>\0<新路径>\0`），解析时要一并吞掉原路径、只留新路径。实测确认过这个格式，没有靠猜。
- **看差异的基线参数做成 serde 标签枚举 `DiffSource`**（`{"mode":"staged"}` / `{"mode":"commit","rev":...}`），而不是"一个 staged 布尔 + 一个可选 rev"：后者到了调用处还得再判断一次到底看哪个，容易写漏；枚举让三种组合在编译期就是穷尽的。配套的 `checked_rev` 只放十六进制提交号过去——rev 会被拼进 `cat-file` 的 revision spec，放任任意字符串等于把 revspec 语法（`..`、`^`、`@{...}`、`:/正则`）暴露给前端。
- **提交历史只在展开时拉**：面板默认收起、改动列表才是主角，收起状态下一次 git 都不跑。提交成功后 / 点刷新 / 换工作区才重拉，不跟着 2 秒的状态轮询走（那是白烧进程）。
- **同一个文件的三种差异靠 model URI 的 scheme 段区分**（`codedock-diff:/<unstaged|staged|commit-<短hash>>/<路径>/<侧>`）：否则普通文件 model 和三种差异 model 会撞在同一个 URI 上。
- **提交历史的高度是"固定高度块 + 可拖上边缘"**，不是塞进 `SplitPane`：`SplitPane` 算的是百分比、还带收起语义，而这里需要的是"上边缘可拖、展开时高度固定、收起时只剩标题栏"。拖动上限还得看面板自身多高（留出上面的提交框和几行改动列表），否则能把上面挤没。拖动期间 `body` 挂 `codedock-dragging-row`（`styles.css` 里和横向的 `codedock-dragging` 分开，光标分别是 `row-resize` / `col-resize`）。

## 快捷键

| 快捷键 | 作用 |
| --- | --- |
| `Ctrl+S` | 保存当前文件 |
| `Ctrl+Enter` | 在提交信息框里提交 |
