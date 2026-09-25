# CodeDock

面向软件开发人员的 AI 编程驾驶舱。左侧是真实终端，也可以切成对话式的智能体；右侧是文件浏览与代码编辑。

```
┌────────────────┬────────┬──────────────────────────┐
│ 终端 (PTY)     │ 文件树 │                          │
│    ⇅ 切换      │        │   Monaco 编辑器          │
│ 智能体 (对话)  │        │                          │
└────────────────┴────────┴──────────────────────────┘
        ↑ 分栏可拖动          ↑ 分栏可拖动
```

## 功能

- **工作区**：启动时自动打开上次用的目录；没有记录（或目录已不存在）就停在空态，等用户选。最左侧是侧边栏：上面是「打开文件夹」，下面「项目」分组列出用过的目录（最近的在最前，当前项高亮），点一个即可切换，终端与文件树一起切过去。每行悬停时右侧出现 `⋯`，点开是三个操作：**打开**（用系统的文件浏览器打开这个目录：Windows 资源管理器 / macOS 访达 / Linux 文件管理器）、**重命名**（只改 CodeDock 里显示的名字，**不动磁盘上的文件夹名**；清空或写回目录原名就等于去掉别名）、**移除**（只把这条记录从列表里去掉，**不碰磁盘上的目录**；移掉的正好是当前项目时会顺手清掉启动记录，否则下次启动又被补回来，但本次会话继续开着）。重命名是就地编辑：`Enter` 确认、`Esc` 取消、点别处也算确认。左下角是主题切换、设置和侧边栏的收起/展开按钮（三个并排，收放在最右）。侧边栏可收起成一条图标宽的竖条，展开收起时图标只横向挪位、不上下跳。
- **终端**：`portable-pty` + ConPTY 起真实 shell（`pwsh` → `powershell` → `cmd` 自动探测），xterm.js 渲染，支持 WebGL 加速与窗口缩放 reflow。没选工作区时 shell 落在用户主目录。标签栏可新建（`+`）、关闭（`×`）、切换多个会话，每个会话各自一个 PTY，切走的会话仍在后台跑。展开/收起右边栏内容面板的按钮沉在右边栏图标条的最下面，和左侧栏的收起按钮一条水平线。
- **文件树**：在右边栏的「文件」模块里，目录懒加载，点击文件在编辑器中打开，可切换工作区目录。以 `.` 开头的隐藏文件和目录照常列出。头部有「新建文件」「新建文件夹」两个按钮：在树里就地长出一个输入框，`Enter` 建好、`Esc` 取消，重名或名字非法就地把错误显示出来、输入不丢。建在哪儿看当前选中的那一行——选中目录就建在目录里，选中文件就建在它旁边，什么都没选就建在工作区根；**点目录也算选中它**（和 VS Code 一样，选中和展开是同一次点击）。目录结构由后端监听，别的程序（终端、git、另一个编辑器）改了工作区，文件树会自己跟着刷新，不用手点刷新按钮。头部还有个搜索按钮：点开变成输入框，按文件名做大小写不敏感的子串匹配（`Esc` 或 `✕` 关闭），结果是**就地过滤文件树**——只留通往命中项的目录并把它们展开，不是另开一个结果列表。搜索由后端递归遍历整个工作区完成，会跳过 `node_modules` / `.git` / `target` / `.venv` / `__pycache__` 等目录，并且有 300 条结果、10 万次目录项的上限。在树里**右键**任意一行（文件或文件夹都行）会弹出菜单：**复制路径**（原生绝对路径）、**复制相对路径**（工作区内的相对路径，一律用 `/` 分隔，粘到代码或终端里都能直接用）、**重命名**、**删除**。重命名是就地编辑：`Enter` 确认、`Esc` 取消、点别处也算确认，默认只选中主干名、扩展名留着；**只改最后一段名字**，不会把东西搬到别的目录去，重名会被后端拒绝。删除文件和文件夹都支持，文件夹连里面的内容一起删（**不可撤销**，走应用内确认框）。改名或删除之后，编辑器里指向它的标签会跟着换路径或关掉——改名前会先把未保存的改动落盘，重命名不保留撤销历史。工作区根目录既不能改名也不能删除。
- **编辑器**：在右边栏的右半边，Monaco（VS Code 内核），离线可用（worker 打包进产物，不走 CDN），按扩展名自动识别语言。同时打开多个文件时排成标签，可切换、关闭（有未保存改动会先确认），`Ctrl+S` 保存当前文件。
- **主题**：深色 / 浅色 / 跟随系统，选择记在 localStorage。终端和 Monaco 各有两套配色跟着一起换。
- **设置**：左下角齿轮打开，存在 `codedock.settings` 一块 JSON 里。目前有主题、终端字体/字号、编辑器字体/字号、AI CLI 命令列表、AI 生成提交信息用的接口配置（接口地址 / 模型 / 密钥），以及智能体（GUI）的开关、opencode 可执行文件和端口；字体和字号改完立刻生效（终端会重新 fit 并同步行列数给 PTY），字体留空回落到默认等宽栈。智能体那三项里只有开关是立刻生效的，可执行文件和端口要等下次启动智能体才读。
- **AI**：两条路——终端里的 AI CLI，和对话式的智能体。TUI 模式下，当前项目行右侧有个 `+`（和 GUI 模式下「新建对话」的 `+` 同一个位置，两种模式互不重叠）：点它往**当前活动的终端会话**里注入命令，默认配了 `claude` / `codebuddy` / `opencode` 三个；配了多个时出下拉选择（每项名字前面对应 agent 的品牌 logo，认不出的回落成通用机器人图标），只有一个时直接执行。列表在设置里增删。另有一处「用大模型」的地方：右边栏「变更」里的提交框旁有「生成」按钮，把**暂存区的改动**连同当前分支、最近几条提交的主题一起发给一个 OpenAI 兼容接口，让它写一条提交信息填进框里（可编辑、不自动提交）。生成的消息走统一的 **Conventional Commits 模板**——`<type>(<scope>): <subject>`，下面按需跟 body / footer（没内容就连空行一起省掉），type 限定在 feat / fix / docs / style / refactor / perf / test / build / ci / chore / revert 里选；body 要求精简，改动点多时按改动点分条列出（`- ` 开头，一条一句，不按文件罗列）。接口地址 / 模型 / 密钥在设置的「AI」分类里填，任何 OpenAI 兼容的服务都能用（OpenAI、DeepSeek、Kimi、智谱、Ollama…）。没配全时点「生成」会直接提示去设置里填。
- **智能体（对话编程）**：终端区顶栏左上角是 **TUI / GUI** 两个入口，两边各是一套完整界面——TUI 侧是终端和它的标签栏，GUI 侧是下面这套对话面板，两者不共用工具栏。智能体这侧是对话面板：说一句话，后端跑的 **opencode**（开源 agent）替你去读代码、改文件、跑命令，过程实时渲染成消息流——助手正文用 markdown 排版，每次工具调用是一张可展开的卡片（读了哪个文件、跑了什么命令、输出是什么、成功还是失败）。改动直接落到工作区，文件树和 git 面板会跟着刷新。会话 id 按工作区记在 localStorage 里，切走再切回来接着聊；新建对话和历史会话都收在**侧边栏当前项目行右侧**——`+` 新建一条，`⌄` 展开/收起该目录的历史会话列表（标题 + 最近活动时间，默认展开），点一条就切过去接着聊，当前那条用整行底色标出来；每行悬停时右侧的最近活动时间会换成 `⋯`（不悬停时显示时间），点开是 **重命名**（就地改标题，`Enter` 确认 / `Esc` 取消，只动 opencode 那边的标题、不动消息）和 **删除对话**（连消息一起没，走自研确认框，不可撤销）——删的正好是正在聊的那条就退到最近的一条，一条都不剩就新建一条。这组历史只在终端区停在 GUI 时出现。一轮在跑的时候发送键变成停止键（对应 opencode 的 abort）。流式输出期间按纯文本渲染、这一轮结束才上 markdown，免得每来一个字都重排一遍。关掉设置里的「智能体（GUI）」就完全回到纯 TUI。
- **智能体依赖**：要单独装 [opencode](https://opencode.ai)，保证 `opencode` 在 PATH 里（找不到就在设置的「AI」分类里填完整路径）。接口配置复用上面那份（基地址 / 模型 / 密钥）。CodeDock 会在自己的配置目录里生成一份 `opencode.json`，用 `OPENCODE_CONFIG_DIR` 指过去——**不碰你全局的 opencode 配置，也不往工作区里写配置文件**；密钥只通过环境变量传给子进程，不落盘。opencode 进程按工作区起一个，换工作区或退出应用时收掉。
- **git**：文件树每行右侧和编辑器标签页上有状态字母——`M` 黄（改动）、`A`/`U` 绿（新增 / 未跟踪）、`D` 红（删除）、`C` 红（冲突）。打开时最右是一条**常驻的图标条**（文件 / 搜索 / 变更 / 浏览器），右边栏的内容面板（模块 + 编辑器）默认收起——点图标条上的模块就展开它，再点同一个图标收起，终端右上角那个按钮也管同一件事。展开后是 [图标条 | 模块内容 | 编辑器]，点「变更」就是改动管理：提交信息框（默认一行，内容折行后自己长高、最多 5 行，再多就滚动；下边缘有一条可拖的细条，拖过之后高度就定死、不再随内容长高，内容多了框内滚动，高度记在 localStorage；`Ctrl+Enter` 提交，旁边有「生成」按钮见上一条）+「暂存的改动」/「改动」两个列表，每行悬停出现 `+`/`−` 暂存或取消暂存、以及一个回退箭头用来**放弃修改**（点开会弹应用内确认框，不可撤销：「改动」组还原到暂存区的版本，「暂存的改动」组还原到 HEAD、暂存与工作区一起丢），两个分组标题右侧各有「全部放弃」和「全部暂存」/「全部取消」。**新文件不给放弃按钮**——未跟踪的、暂存区里新增的都排除在外，因为对它们来说"放弃"等于把文件删掉；要删就去终端或文件管理器。点改动项在编辑器里打开的是**差异视图**（内联、只读，标签上带 `↔ index` / `↔ HEAD` 后缀），基线照 VS Code——「改动」组比 index，「暂存的改动」组比 HEAD；未跟踪文件基线为空、被删文件当前侧为空。面板底部还有一个可折叠的**提交历史**（短 hash + 提交信息，悬停看作者和时间），点一条就展开它改过的文件、点文件打开「该提交 vs 它的父提交」的差异（标签上是 `↔ <短 hash>^`）；展开时**拖它的上边缘能改高度**（拖动条在收起状态下不画——没有东西可调）。面板标题栏上还有**获取 / 拉取 / 推送**三个按钮，拉取和推送旁边显示 ↑领先 / ↓落后上游的提交数：获取只更新远程跟踪引用和计数，不碰工作区；拉取是**只允许快进**的 `git pull --ff-only`，本地与远程分叉时直接报错停下，不会悄悄产生合并提交、也不会把仓库带进冲突状态；推送在分支还没有上游时顺手建立跟踪关系，落后于远程时 git 自己会拒绝（**不做 force push**）。三个操作都把 git 的原文报错丢进面板里那个报错区，跑起来时按钮变灰、下方显示「正在拉取…」。认证走系统上已配好的凭据（Git Credential Manager / ssh-agent），应用里不弹交互式提问，缺凭据就把 git 的报错摆出来，去终端处理一次即可。目录不是 git 仓库时图标条里的「变更」置灰不可点，界面停在「文件」。收起只是把右边栏裁掉、并不卸载，所以文件树的展开态、提交草稿、Monaco 的撤销历史都留得住。只读查询带 `--no-optional-locks`，不会和用户在终端里敲的 git 抢 index 锁。不是仓库、或系统里没有 git 时，这些标记整体消失，其余功能不受影响。
- **git 不做的事**：reset、分支切换、force push、解决合并冲突、在两个提交之间任意对比（只能看「提交 vs 父提交」）。工作区里嵌套的子仓库也不会被单独识别。新文件的「放弃」等于删文件，所以不做——未跟踪的和暂存区里新增的都不给按钮。

## 开发

```bash
pnpm install
pnpm tauri dev     # 开发（热重载）
pnpm tauri build   # 打包
pnpm build         # 仅前端类型检查 + 构建
cd src-tauri && cargo test --lib   # 后端测试（路径沙箱 + PTY 往返 + git 输出解析与暂存/提交）
```

环境：Rust 1.98+、Node 24+、pnpm 11+、WebView2（Windows 10/11 自带）。

### 打包与发布

`pnpm tauri build` 产出两个安装包，都在 `src-tauri/target/release/bundle/` 下：`msi/CodeDock_<版本>_x64_zh-CN.msi`（WiX 打的 MSI）和 `nsis/CodeDock_<版本>_x64-setup.exe`（NSIS 打的 exe），两个都是中文安装界面。

发行者「硅原子」写在两处：`src-tauri/tauri.conf.json` 的 `bundle.publisher`，以及 `Cargo.toml` 的 `authors`。`publisher` 不写的话默认取 identifier 的第二段（也就是 `codedock`），而且它只在 Windows 安装包和 deb 的 Maintainer 上生效，所以两处都写才一致。

**中文发行者必须同时把安装包语言配成中文**：MSI 的数据库代码页跟着 WiX 语言走（`en-US` → 1252），装不下中文字符，`light.exe` 会报 `LGHT0311: A string was provided with characters that are not available in the specified database code page '1252'`——而 Tauri 只把它显示成一句 `failed to run light.exe`，看不出原因，得手动到 `target/release/wix/x64/` 下重跑一遍 `light.exe -ext WixUIExtension -ext WixUtilExtension -cultures:en-US -loc locale.wxl main.wixobj -o test.msi` 才能看到真正的报错。所以 `bundle.windows.wix.language` 是 `zh-CN`（代码页 936），`bundle.windows.nsis.languages` 是 `["SimpChinese"]`。

**发布者 ≠ 代码签名**：`publisher` 只是写进安装包元数据（MSI 的 Manufacturer 属性、NSIS 写进注册表 `Uninstall\...\Publisher`，也就是"程序和功能"里显示的那个），用户双击安装包时 SmartScreen 仍会提示"未知发布者"。要消除得买代码签名证书，再配 `bundle.windows.certificateThumbprint`。

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
    Sidebar.tsx           侧边栏：项目历史（含当前项目的对话历史）/ 打开文件夹 / 主题切换（可收起成图标条）
    CliHistory.tsx        侧边栏底部：当前 AI CLI 的会话历史（选择器 + 列表），点一条新开终端跑 resume
    WorkspaceEmpty.tsx    还没选工作区时的空态（选文件夹，或显示上次那个目录为什么打不开）
    TerminalPane.tsx      终端区：顶栏 TUI / GUI 切换，TUI 侧管标签栏与会话增删
    TerminalSession.tsx   单个会话：一个 xterm 实例独占一个 PTY
    AgentPane.tsx         智能体对话面板：消息流 + 输入框，后端是一个 headless 的 opencode
    AgentMessageView.tsx  渲染单条消息：用户气泡 / 助手的 markdown + 工具卡片
    AgentToolCard.tsx     一次工具调用的卡片：一行摘要 + 可展开的输出
    ExplorerPane.tsx      文件树状态机（展开 / 懒加载 / 选中）
    FileTreeNode.tsx      递归节点
    EditorPane.tsx        Monaco 包装：复用单个 editor + 多 model 标签，另有只读的内联 DiffEditor 和 markdown 预览层
    MarkdownPreview.tsx   markdown 预览层：只读 HTML + 拦掉链接跳转，排版样式在 styles.css 的 .markdown-body
    GitMarkBadge.tsx      文件树与标签页共用的 git 状态字母
    ToolRail.tsx          右边栏最左侧的图标条（44px）：切换文件 / 搜索 / 变更 / 浏览器，底部收放内容面板
    ToolPane.tsx          右边栏各模块的内容容器（文件树 / 变更 / 浏览器），常挂载只切显隐
    GitChangesPane.tsx    「变更」模块：改动列表 + 提交框 + 暂存/取消暂存
    BrowserPane.tsx       「浏览器」模块：iframe 内嵌本地服务，地址栏补全片段 + 刷新即重挂
    FullscreenButton.tsx  三个模块标题栏右端共用的全屏开关（铺满窗口，侧边栏和终端让位）
    SettingsDialog.tsx    设置面板：左侧竖排 tab（外观 / 终端 / 编辑器 / AI），固定尺寸、滚到两端翻页
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
    ai.ts                 invoke 薄封装：调大模型生成提交信息
    agent.ts              智能体：invoke 薄封装 + SSE 事件的纯函数归并（reducer）
    agent-session.tsx     TUI/GUI 模式、会话列表、当前会话的共享状态（侧边栏与对话面板共用）
    cli-sessions.ts       CLI 会话历史：认 CLI 品牌、拼 resume 命令、按项目记住选的是哪家
src-tauri/src/
  pty.rs                  PTY 会话管理
  cli_sessions.rs         读各 CLI 写在磁盘上的会话记录（codebuddy / claude），按 cwd 过滤
  fs_api.rs               文件读写/新建 + 路径沙箱（未选工作区时全部拒绝）+ 按文件名递归搜索
  watcher.rs              工作区目录监听：防抖后把「哪个目录变了」推给前端
  git.rs                  git 状态查询、暂存/提交、提交历史与差异内容（调用系统 git CLI）
  ai.rs                   AI 生成提交信息：取暂存区上下文、拼 prompt、走 reqwest 调 OpenAI 兼容接口
  agent.rs                智能体后端：起停 opencode 进程、代理它的 HTTP、把 SSE 转推给前端
  lib.rs                  state / command 注册 / 退出回收
```

### 几个关键实现决定

- **PTY 输出走 base64，不在后端解码**。`read()` 会把多字节 UTF-8 从中间截断，后端一旦 decode 就产生乱码。后端只搬运字节，由前端 xterm 自己拼接跨 chunk 的序列。
- **输出走 `Channel<PtyEvent>` 而非全局事件名**。避免动态事件名，也避免多终端实例串台。
- **文件路径一律经词法归一化 + 前缀校验**。目标不存在时 `canonicalize` 会失败，所以创建类操作靠词法归一化挡 `..`，已存在的路径再走 `canonicalize` 挡软链接逃逸。越界直接报错。
- **「复制路径」走 Tauri 的 clipboard 插件，不用 `navigator.clipboard`**：WebView 那套要求文档有焦点，WebView2 上实测点一次「复制路径」会直接跳到系统授权框（`edge://permission-request-dialog/`），用户得先点「允许」才复制得成。插件是从 Rust 侧直接写系统剪贴板，三端都不问人；代价是多一个依赖和一条 capability。菜单的定位照项目行的 `⋯` 菜单（`fixed` + 点开时取视口坐标），因为树本身是滚动容器，绝对定位会被裁掉。
- **文件树里改名/删除要顺手把编辑器的标签带上**：只改磁盘的话标签还指着旧路径——改名后按 `Ctrl+S` 会在老位置凭空写回一个文件，删除后更是把删掉的东西复活。所以 `fs_rename` 把新路径回传给前端，`EditorPane` 暴露一个 `dropPaths` 把落在这些路径下的 model（普通文件和差异成对的）一起丢掉，标签要么换成新路径、要么关掉，model 由编辑器按新路径重读。**改名前的未保存改动必须先落盘**（复用替换那套 `saveAll`），否则 model 一丢就没了；重命名不保留 Monaco 的撤销历史。`fs_rename` 只收「一段名字」，分隔符被校验挡掉，所以不存在把文件搬到工作区外这回事；重命名/删除工作区根目录由后端直接拒绝（根的路径在 `resolve` 里是合法的，不挡就会把沙箱边界改掉）。Windows 上大小写不敏感，`a.txt` → `A.txt` 时 `exists()` 会误报"目标已存在"，所以占用检查比的是小写化的路径。
- **Monaco worker 用 Vite `?worker` 内联**，`monaco-editor` 的 exports map 是 `"./*" -> "./esm/vs/*.js"`，导入路径不能再带 `esm/vs` 前缀。
- **终端容器不设 padding**：FitAddon 只扣 xterm 自身 padding，不扣父元素的，父元素留 padding 会导致列数算多。
- **终端容器必须 `overflow-clip`**：输入法合成时 xterm 的 `.composition-view` 按光标位置画，光标靠右时会伸出行尾。浏览器为了让这个"焦点附近"的内容可见，会横向滚动最近的可滚动祖先——分栏面板虽然写着 `overflow: hidden`，照样能被程序滚动，于是整块终端被推左、合成结束再弹回，表现就是打汉字时屏幕左右抖。用 `clip` 而不是 `hidden`，因为 `clip` 连程序滚动都不允许。代价是超出右边缘的合成文字会被裁掉一点。
- **React StrictMode 下的 PTY 竞态**：effect 会在首次挂载后立刻重跑一次，若 spawn 的 `await` 尚未返回，清理逻辑拿不到 handle，必须用 `cancelled` 标记在 await 之后补一次 `kill`，否则会留下两个 shell。同一个标记也用来丢弃作废会话的 `Exit` 事件，否则第一次挂载的会话退出后会把「shell 已退出」打到存活的界面上。
- **切换工作区必须前后端一起换**。后端 `fs_set_root` 决定文件读写的沙箱边界，前端 state 决定界面渲染；只改前端会让后端拿旧根目录去校验新路径，直接报"路径越界"。切换后终端靠 `key` 重建（见下条），文件树则要丢弃在途的旧请求，否则旧工作区返回的错误会盖到刚加载好的新目录上。
- **切换工作区靠重开 shell，不往运行中的 shell 塞 `cd`**：跨盘符、不同 shell 的转义规则都不一样，重开是唯一确定的做法（代价是丢掉滚动历史和正在跑的 AI CLI 会话）。多会话下同理，换工作区时整个终端区连同所有标签一起重建。
- **非当前会话用 `display:none` 藏起来而不是卸载**：卸载会杀掉 shell，切回来历史就没了。代价是藏起来的会话量不到尺寸（FitAddon 会算成 0），所以切回来那一帧要补一次 `fit()` 并把新的 cols/rows 同步给 PTY。
- **git 状态走 `status --porcelain=v2 --branch -z`**。v2 的 XY 两列分别给出暂存区和工作区状态，比 v1 好判断；`-z` 让路径不做引号转义，空格和中文原样拿到，省掉一整套反解析（也因此不用管 `core.quotepath`）。`-z` 下重命名记录后面还跟着一条原路径，解析时必须一并吞掉。
- **工作区可能只是仓库的一个子目录**：先跑 `rev-parse --show-prefix`，一次调用同时回答"是不是仓库"和"工作区在仓库里的位置"，再用它把仓库级的条目折算成工作区内的绝对路径（前缀带尾斜杠，`sub/` 不会误伤 `subber.txt`）。
- **智能体的 HTTP 和 SSE 都走 Rust 代理，前端不直连 opencode**。它监听在 localhost 的动态端口上，不会给 WebView 回 CORS 头，直连必被拦；端口每次还可能不一样。顺带把密钥和网络调用留在 Rust 侧，和 `ai.rs` 一个路子。
- **SSE 事件推给前端用全局事件名（`agent-event`）而不是 `Channel`**。全局只有一个 agent 服务、不会有终端那种多实例串台，静态事件名就够；而且**只有一条 SSE 连接**，天然扛得住 React StrictMode 的双挂载。
- **opencode 的 SSE 只有 `data:` 行、没有 `event:` 行**，事件类型在 JSON 的 `type` 字段里。它的载荷还有两种壳：老的放 `properties`、新的 durable 事件（如 `session.idle`）放 `data`，读的时候得兼容。
- **Windows 上 npm 装的 opencode 是 `.cmd` 垫片**：`CreateProcess` 只补 `.exe`、不认 `.cmd`，`Command::new("opencode")` 必然失败。所以要先扫 PATH 找 `.exe`/`.cmd`/`.bat`，命中 `.cmd` 时借 `cmd /S /C` 起（`/S` 让它只剥掉最外层一对引号，路径带空格也不会被拆散）。杀的时候也要连进程树一起杀——它跑 bash 工具会派生子 shell，`child.kill()` 收不干净，Windows 上走 `taskkill /PID <pid> /T /F`。
- **发消息必须显式带 model**。不带的话 opencode 会用用户全局配置里的默认模型——本机实测落到了没跑起来的本地 ollama，然后一路重试到超时。
- **给 opencode 的配置里写死 `"permission": "allow"`**。第一版没有审批 UI，不放行的话 `doom_loop` / `external_directory` 这类默认 ask 的规则会让会话卡在那儿等人点确认。这是有意的取舍，等审批 UI 做出来再收紧。
- **TUI / GUI 这个选择是组件本地 state，而开关是设置里随时能改的**：关掉开关时那两个 tab 不画了，要是渲染还认那个 state，人就被锁在 GUI 面板里出不去，还会白白起一个 opencode。所以渲染用的是一个派生值（开关关掉就当 TUI），另外再用 effect 把 state 也归零——不归零的话重新打开开关会突然跳回 GUI 面板，看着像自己乱切。
- **GUI 的历史会话以 opencode 为准，localStorage 只记「当前选中的那条」**：`GET /session` 是全局的，把各个项目的对话混在一起返回，所以得按 `directory` 过滤（`parseSessions`），否则在 A 项目里会看到 B 项目的会话。启动时先问列表——本地记的那条还在就用它，否则退一步接**最近的一条**，一条都没有才新建；不这么兜的话，清过缓存或会话被删掉时会凭空多出一个空会话。
- **TUI/GUI 模式、会话列表、当前会话提到 `lib/agent-session.tsx` 共享**：侧边栏要在当前项目下列出该目录的对话历史，这几个状态原先关在 `TerminalPane` / `AgentPane` 内部就够不着了。侧边栏点一条历史走的是 `requestSession`（顺带把模式切到 GUI），真正的打开动作由 `AgentPane` 在服务就绪后消费 `requestedId`——服务没起来时硬开会去拉一个还没起的 opencode。换工作区（`cwd` 变）时这几项一起归零，否则会拿旧目录的会话列表去配新目录的项目行。侧边栏那个 `+`（新建对话）走同一套：`requestNew` 只置个标志，真正建会话的 `newSession` 留在 `AgentPane` 里、且要等服务就绪才执行。
- **删会话 / 改标题只把请求交给 `AgentPane`，收尾逻辑留在面板侧**：侧边栏负责弹确认框、就地编辑标题，然后调 `requestDelete` / `requestRename`，真正的 `DELETE /session/:id`、`PATCH /session/:id`、以及改完刷新列表都在 `AgentPane` 里做；删除还要额外处理"删的是当前这条就退到最近一条 / 一条不剩就新建"，这些都要碰对话状态，搬到侧边栏等于把 AgentPane 的模型拆出去。删除不可撤销，走自研 `ConfirmDialog` 而不是 `window.confirm`（理由同「放弃修改」那条）。
- **会话行悬停时用 `⋯` 顶掉时间，而不是并排**：一行只有 200px 出头，标题、时间、`⋯` 三个并排会把标题挤成两三个字。所以不悬停时右侧给时间、悬停时换成 `⋯`（`group-hover/hist:hidden` + 反向 `opacity`），互斥出现，标题始终拿到最大宽度。
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
- **提交框"自动长高"和"手动拖高"是互斥的，拖动接管**：默认随内容长高（`scrollHeight` 量，最多 5 行），一旦拖过下边缘那条细线就切成固定像素高度、内容多了框内滚动——两种模式同时生效会互相打架（打字就把拖好的高度顶回去）。拖动起点从 DOM 现量当前高度而不是读 state：没拖过时高度压根不在 state 里，否则一按下去框会跳成上次存的像素值。上限同样看面板高度（`MESSAGE_RESERVED_BELOW`），下限是一行。高度存 `codedock.commitMessageHeight`，没存过就仍是自动长高。行高必须先用 `leading-4` 定死，否则 `getComputedStyle` 的 `lineHeight` 返回 `"normal"`，换算不出"一行多少像素"。
- **AI 生成提交信息走 Rust 侧 reqwest，不走前端 fetch**：密钥不进 WebView（前端只把设置传给后端命令），也不受各厂商跨域限制。`reqwest` 用 `rustls` 特性而不是 `native-tls`（注意 0.13 起叫 `rustls` 不叫 `rustls-tls`），三端都不依赖系统 OpenSSL。上下文只喂**暂存区 diff + 分支 + 最近 5 条提交主题**——提交的是暂存区，拿工作区全量改动会让信息跟实际提交对不上；diff 按**字符**截断（24k，按字节切会劈坏 UTF-8），截断时在末尾注明，免得模型以为改动就这么多。输出模板固定成 Conventional Commits（type 候选写死在 system prompt 里），不让模型自己发挥格式；模板里的 `<body>` / `<footer>` 没内容时要求连同空行一起省略——留个空段落比没有更糟。`<body>` 另外要求精简（明确点名别写「本次提交」「我们」这类套话），改动点多时按改动点分条列出、一条一句，并禁止按文件逐个罗列——不写死的话模型爱把 diff 逐文件复述一遍，又长又没用。响应不定义严格结构体、直接用 `Value` 逐层取：换一家接口少一层字段就反序列化失败，取不到时把响应体片段带进错误里方便排查。git 上下文在第一个 `await` 之前同步取完，别让 std 的锁跨越 await 点。
- **远程操作用独立的超时和环境变量**：`fetch`/`pull`/`push` 走单独的 `NETWORK_TIMEOUT`（180 秒）——本地 git 几十毫秒就回来，写操作那 30 秒拿去卡网络必然误报。命令一律带 `GIT_TERMINAL_PROMPT=0`：应用没有 TTY，不关掉交互式提问的话 git 会一直等着输入用户名密码，把整个超时耗光才报"超时"，用户完全看不出是缺凭据。凭据交给系统已配好的 credential helper / ssh-agent。这些操作**不带** `--no-optional-locks`——它们本来就要更新 refs 和 index.lock。
- **pull 强制 `--ff-only --no-rebase`**：`--ff-only` 保证分叉时直接失败，不产生合并提交、也不把仓库带进冲突状态（冲突在界面里给不出像样的处理方式，交给终端）；`--no-rebase` 把用户全局配置里的 `pull.rebase=true` 压掉，行为到哪台机器都一样。ff-only 不生成合并提交，所以不需要 `--no-edit`。
- **push 在没有上游时自动 `-u`**：不建立跟踪关系的话推完 ahead/behind 还是空的，用户看不出到底推成功没有、下次还得再推一次。远程取 `git remote` 的第一行（按字母序，常见仓库里 `origin` 天然在最前），一个都没有就给一句能看懂的提示。落后于远程时 git 自己会拒绝，不做 force push。
- **「放弃修改」用 `git restore` 的两种模式，并且不做"全部"**：`restore --worktree`（源是 index）只丢工作区，「改动」组用它，暂存区里那版留着——所以 `MM` 这种文件在两个组里各放弃一次是两件不同的事；「暂存的改动」组用 `restore --source=HEAD --staged --worktree`，index 和工作区一起回到上次提交。后端**不接受空路径**、也不提供 pathspec `.` 的"全部"：两个分组的还原目标不同，一把梭会把另一组的改动也带上，所以「全部放弃」是前端把该组里能放弃的路径列出来传过去。**新增的文件不在支持范围**：HEAD 里没有这个路径，还原过去等于把文件删掉（未跟踪的 `?`、暂存区里的 `A` 都不给按钮，和"未跟踪文件不给按钮"是同一条理由）。空仓库里所有暂存文件都是 `A`，于是空仓库天然不支持放弃暂存改动。
- **破坏性操作的确认框自己画，不用 `window.confirm`**：WKWebView（macOS）不支持 `confirm` / `prompt`，调用会**静默失效**——不弹框、直接返回，用户根本不知道发生了什么；wry 只在 Android 后端处理了脚本弹窗，Windows/macOS/Linux 三端都没接管。所以「放弃修改」走自研的 `ConfirmDialog`（和设置面板同一套弹窗外壳），三端行为一致，还能把确认按钮做成危险色。`EditorPane` 关标签和 `SearchPane` 全部替换那两处仍是 `window.confirm`，在 macOS 上同样有这个问题，要一起换的话直接复用这个组件。
- **项目的显示名只存在 localStorage 里**（`codedock.workspaceNames`，按目录路径索引，见 `lib/fs.ts`）：重命名是界面上的别名，绝不碰磁盘。清空或写回目录原名就把这条记录删掉——留着的话，用户真去改了目录名，界面还会被旧别名盖住。移除项目时连同它的别名一起清。
- **「打开」用 `tauri-plugin-opener` 的 `openPath`，但 `open_path` 除了权限还要求 scope**：只往 capabilities 里加 `opener:allow-open-path` 会被插件自己的 `Scope::is_path_allowed` 挡掉，报 `Not allowed to open path ...`——看着像权限没配好，其实是 scope 为空。得写成带 `allow` 的对象形式；这里给 `{"path": "**"}`，因为工作区可能在任意盘符、收窄不了。
- **项目行的「⋯」菜单用 `position: fixed` 而不是绝对定位**：项目列表是 `overflow-auto` 的滚动容器，绝对定位的菜单会被裁掉，靠窗口底部的项目就看不到菜单了。位置在点按钮时从 `getBoundingClientRect()` 现量，纵向再跟窗口高度取个 min，免得贴底时被顶出去。
- **右边栏的图标条常驻，收起的是内容面板**：工作区一打开，`ToolRail` 就一直画在最右侧，`rightOpen` 只管「模块内容 + 编辑器」那一列；点当前已选中的模块等于收起（VS Code 那套），图标条底部还有一个收放按钮（和左侧栏的收起按钮同一条水平线）。为此 `SplitPane` 的 `secondCollapsed` 从「宽度归零」改成「按内容宽度收（`flexBasis: auto`）」——第二块里只剩那条 44px 的图标条，于是自然收成一条竖栏，终端顺势占满其余宽度。内容面板是 `hidden` 藏着而不是卸载，文件树的展开态、提交草稿和 Monaco 的撤销历史照样留得住。
- **AI CLI 的入口在侧边栏，执行在终端**：入口是项目行右侧那个 `+`（TUI 模式下才出现），而「往活动会话写命令」这件事只有 `TerminalPane` 做得了——会话句柄都关在它里面。所以走 `TerminalPaneHandle`（ref，和 `EditorPaneHandle` 一个路子）把它暴露给 `App`，再由 `App` 以 `onRunAiCommand` 传给侧边栏；没有架 Context，因为只有这一个动作、一层传递。菜单用 `fixed` 定位且比别的菜单宽（`AI_MENU_W`），名字前面挂 `AgentLogo`——按命令的第一个词认品牌（认得出 `npx opencode` 这种），认不出再按用户起的名字认，都不中回落成通用机器人图标。
- **CLI 的会话历史读磁盘，不反解 slug**：codebuddy 和 claude 都把记录写成 `~/.codebuddy|.claude/projects/<slug>/<会话 id>.jsonl`，而 slug 是**有损**的（绝对路径里的 `-` 和分隔符撞车，两家的规则还不一样），反算会把 `/a-b/c` 和 `/a/b-c` 认成同一个。所以 `cli_sessions.rs` 遍历所有项目目录、读文件头里的 `cwd` 字段**正向匹配**，另外只在两层目录里认 `.jsonl`，旁边的 `<id>/tool-results/`、`memory/` 天然被挡掉。代价是每次要翻一百多个文件（读头封顶 128KB），所以**不做轮询**，只在挂载 / 换项目 / 换 CLI / 手动刷新时读。
- **标题的取法按 CLI 分开，且必须跳过 CLI 自己塞的文本**：codebuddy 是 `ai-title.aiTitle` > `providerData.source === "initial-user-message"` 的 `summary` > 首个干净的 user 文本（同一个文件靠后还有 `periodic` / `pre-compact` 的上下文压缩摘要，判据必须是 `source` 而不是"位置靠前"，否则会拿到 `<conversation_history_summary>`）；claude 没有 `ai-title`，只取首个干净的 user 文本，且要跳过 `isMeta` / `isSidechain` 记录、`content` 是 `tool_result` 块的记录，以及 `<command-message>`、`[Request interrupted by user` 这类 CLI 自己的模板文本。**抠不出标题就留空**，界面显示「未命名会话」——硬造一个出来更误导。另外 0 字节的记录（开了就退的会话）一律跳过，本机实测占了很大比例。
- **resume 必须新开标签，命令要等 shell 就绪再写**：不能把 resume 写进当前活动终端——那儿多半正跑着一个 AI CLI，命令会被当成它的输入。而新标签的 PTY 是异步 spawn 的，`TerminalSessionHandle.write` 走的 `ptyRef.current` 那一刻还是 null，立刻写必然被静默丢掉。所以命令走 props（`initialCommand`）进 `TerminalSession`，**等首个输出块到达再写**（那意味着提示符或 pwsh 的 `ESC[6n` 握手已经出来了）；`await` 之后还补一次，兜住"输出比 await 先到"的情况。`onData` 里读 `ptyRef` 而不是闭包里的 `handle`，因为后者那时还在 TDZ 里。这条命令用 `useState` 而不是 `useRef` 兜住——StrictMode 会立刻重挂一次，用 ref 并在 effect 里清空的话，第二轮就读到空值、命令被悄悄丢掉。
- **会话记录里没有真正的提问时，列表会显示「未命名会话」**：有些会话开完就被打断，第一条 user 是 claude 的中断标记；这类显示空标题比显示标记诚实。

## 快捷键

| 快捷键 | 作用 |
| --- | --- |
| `Ctrl+S` | 保存当前文件 |
| `Ctrl+Enter` | 在提交信息框里提交 |
