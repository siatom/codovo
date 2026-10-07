# AGENTS.md

给在这个仓库里写代码的 AI 助手；功能见 [README.md](./README.md)。栈：Rust + Tauri 2 外壳、
React 19 + TS + Tailwind 4、Monaco 编辑器、xterm.js 终端。**动手前先扫一遍「关键实现决定」。**

## 命令

```bash
pnpm tauri dev                    # 开发
pnpm build                        # 前端类型检查 + 构建
cd src-tauri && cargo test --lib  # 后端单测
cd src-tauri && cargo clippy

pnpm version patch                # 发版：升版本号并打 tag（minor / major 同理）
git push --follow-tags            # 连 tag 一起推
```

## 约定

- 跨平台：涉及系统 API / 路径 / 进程 / 快捷键 / 界面行为时，先考虑 Windows、macOS、Linux 差异。
- 注释一律中文、写「为什么」；反直觉的写法、绕开的坑留一句。
- 颜色只用语义类（`bg-surface`…），新增要同时改 `styles.css` 的 `:root` / `:root[data-theme="light"]` /
  `@theme`；组件具名导出（`App.tsx` 例外）、状态用 Context、图标走 `icons.tsx`。
- 只改被要求改的地方：不重排 import、不改命名、不清理"看起来没用"的代码；宁可重复三行。
- 设置项要动五处（`settings.tsx` → `SettingsDialog.tsx` → 消费方）；后端命令 `*.rs` 写
  `#[tauri::command]` → `lib.rs` 注册 → 前端 `lib/*.ts` 包一层，组件不直接 invoke。
- 版本号**只有一个来源**：`package.json` 的 `version`——`tauri.conf.json` 的 `version` 指向
  `../package.json`（安装包文件名、exe 版本资源都从那儿取），前端由 vite 的 `define` 注入
  `__APP_VERSION__`。**改版本一律走 `pnpm version patch|minor|major`，别手改 JSON**：
  以前是三处硬编码（`package.json` / `tauri.conf.json` / `Cargo.toml`），必然漂移。
  界面上显示的其实是 `<version>+<git 短 hash>[.dirty]`：**版本号是发布里程碑、平时不动，
  后面那串才是「这一次构建」的身份**，用来核对装的是哪一次（`.dirty` = 这个包含未提交的改动）。
  那串标识**不进**版本号本身——Windows 的 exe 版本资源只接受纯 `x.y.z`；dev 构建另带两处标记：
  窗口标题与版本号后的 `(dev)`、侧栏头部的 `dev` 上标——和安装版并存时一眼区分。
- 没有用户明确允许，不要 `git push` / 开 PR / 推分支；提交留在本地等确认。

## 关键实现决定

> 都是踩过坑才定下来的，改之前先弄清为什么。

- 终端输出传**原始字节**、后端不解码（`read()` 会截断多字节 UTF-8）；非当前会话 `display:none` 藏而不卸载
  （卸载会杀 shell）；换工作区靠重开 shell、前后端根目录一起换；容器不设 padding 且 `overflow-clip`。
- **单窗口多工作区**：一个窗口里同时开着多个工作区，侧栏点哪个、右侧（终端 / 智能体 / 右边栏）就切到哪个。
  切走的工作区**在后台继续跑**（shell 不杀、opencode 不停），切回来时终端会话、编辑器标签、文件树展开态
  原样还原。做法是**每个工作区挂一个 `WorkspacePane` 实例**，非当前的 `display:none` 藏着不卸载——
  和 TerminalSession 的会话切换同一套路，状态天然保留，所以**别用 `key={root}` 之类重置它**。
- 后端状态**一律按工作区 root 分片**（`FsState` / `WatchState` / `AgentState` / `PtyState`），命令显式收
  `root: String`；`FsState` 只认「登记过的根」当白名单，否则前端能拿任意路径去读写。事件走全局 `emit`，
  agent 的 payload 是 `{root, event}`，前端按 root 路由。agent 的 `config_dir` 用
  `workspace_dir_name(root)`（非法字符替换 + 稳定 hash）：共用一份会让两个 opencode 争用，而且收掉某个
  工作区时的 `remove_dir_all` 会删掉别工作区的目录。关工作区走 `workspace_close`，一次收掉它的 shell、opencode
  与目录监听。目录监听**只跟当前工作区**，切工作区时整体换掉。
- 持久化的分层：**窗口级偏好存 sessionStorage**（侧栏折叠、CLI 选择）；**工作区级的按 root 作 key**
  （右栏模块、浏览器地址、提交历史视图 / 高度、agent 当前会话）；**跨窗口共享的留 localStorage**
  （设置、主题、工作区列表、别名、远程主机）并靠 `storage` 事件同步（只在别的 document 触发，不会自回流）；
  列表类一律「写前读最新 → 合并去重 → 写」，直接覆盖会抹掉别处刚写进去的。
- 侧栏工作区的顺序**就是那份列表的存储顺序**（`pinned` 只是标记，渲染时把置顶组排最前），拖拽重排走
  `reorderWorkspaces` 按新顺序整份写回、并同步被拖项的 `pinned`。**行容器刻意不 `setPointerCapture`**：
  捕获会把 `click` 重定向到行容器，行内「⋯」「+」这些按钮就全点不动了——所以按下只记起点，
  `pointermove` / `pointerup` 挂 `window`（指针移出行外也收得到），纵向越过 4px 才算拖动，拖完靠
  `onClickCapture` 吞掉浏览器补的那次 click。落点按各行中线算，插进置顶组（`insertAt < 置顶项数`）
  就自动置顶、拖出自动取消。
- 多工作区下的前端约定：git 状态**只轮询当前工作区**（`useGitStatus(root, visible)`，隐藏的工作区停轮询但
  保留状态）；Monaco 从隐藏切回可见要补一次 `layout()`（隐藏期间容器尺寸是 0）；侧栏命令、编辑器浮窗
  这类「打到当前工作区实例」的动作，走 App 里的 `root -> handle` 表路由。
- 文件路径一律词法归一化 + 前缀校验，已存在的再 `canonicalize` 挡软链接逃逸；文件树改名 / 删除
  要带着编辑器标签一起换或关，改名前先落盘；工作区根禁改禁删。
- 目录监听只推「哪个父目录变了」，编辑器重读另走 `fs-file-changed`；防抖 300ms 并跳过 `SKIP_DIRS`。
- markdown 预览层的内容在渲染期算，**按 `activeKey` 从 model 缓存取**，绝不能读编辑器当前挂着的
  model：换 model 的 effect 在渲染之后才跑，从别的文件切到 md 的那一帧读到的还是上一个文件的
  model，而 `isPreview` 由 false 变 true 只发生这一帧，之后依赖不变、memo 不重算，错误内容就一直
  留在预览层上（切回编辑再进预览才会纠正）。
- 差异基线照 VS Code（暂存 `HEAD↔index`、未暂存 `index↔工作区`），两侧统一按 LF 比较；差异编辑器
  懒创建、只读、不参与脏标记，三种差异靠 model URI 的 scheme 段区分。
- git 状态走 `status --porcelain=v2 --branch -z`；工作区可能只是仓库子目录，先 `rev-parse --show-prefix`；
  轮询命令带 `--no-optional-locks`（写操作不带）、Windows 上加 `CREATE_NO_WINDOW`；暂存带
  `--literal-pathspecs`、「全部暂存」给 `.`。
- 提交历史是**图形化的泳道图**（`lib/gitGraph.ts` 排泳道 + `components/GitGraph.tsx` 画线）：后端
  `git log` 带 `--topo-order`（父必须排在子之后，否则泳道接不上）与 `--decorate=full`（`%D` 给
  `refs/heads|remotes|tags/…` 全名，好把分支 / 远程 / 标签分开），`%P` 出父 hash 供连线。泳道按
  「第一父留在原泳道、其余父各占新泳道」记账；颜色是**独立于语义色**的固定调色板（`--c-graph-1…8`，
  深/浅各一套，见 `styles.css`），只求相邻泳道分得开、不跟主题走。图列里 `through` 的泳道用**满高
  竖线**（`self-stretch`）而不是只画提交行那么高——提交展开出文件列表时行会变高，只画行高的话下面
  就缺一截、行与行之间会断线。但**本行才起始的泳道**（分支尖端、合并的第二父）不能算 `through`：
  它上方还没有线，按满高画会在提交点上方多出一截无主出头线；这类归 `tail`，只从提交行底（22px）
  往下延伸。分页每次都拿完整列表从头重排，图不跳变。
- 提交行排版有两处刻意的例外：**标题不左对齐**，用 `graphTextInset` 让它贴住本行的圆圈（右侧还有
  泳道线时才让到线外，`tail` 不算——它的线在提交行下方，压不到标题）；**引用标签按行宽显隐**，
  行上用容器查询（`@container` + `@min-[18rem]:flex`），窄了整组收起、把宽度让给主题。右栏默认只有
  185px，标签和主题同时摆会有一个被挤成 0 宽。
- 提交悬停浮框（`components/CommitTooltip.tsx`）：正文来自 `git log` 的 `%b`（和主题一起拉，
  不额外请求）；改动规模走 `git_commit_stat` 按 hash 懒加载并缓存——悬停很频繁，不缓存就是一片
  git 进程。浮框挂在本行 DOM 里、`fixed` 定位（列表是 `overflow-auto`，绝对定位会被裁），
  和行之间留了 GAP，所以藏要延迟、移进浮框再取消。滚动时收起，免得浮框留在原地。
- 提交历史**会自动重拉**：只盯 HEAD 的话，终端里 `fetch` / `tag` 这类不改 HEAD 的操作会漏掉
  （远程分支、标签这些行内装饰会变），所以挂了个比 status 慢的轮询（`LOG_POLL_MS`，收起时不起）。
- AI / 智能体：HTTP 与 SSE 全走 Rust 代理，前端不直连 opencode；规则 / 记忆 / 技能 / Agents
  存 localStorage、启动时才物化；兼容两代接口、按接口探测（判据是响应里有 `version` 字段）。
- API 密钥进**操作系统凭据库**（`secrets.rs` + keyring），localStorage 只留 `apiKeySet` 布尔位，
  前端全程拿不到明文；opencode 配置里只有 `{env:CODEDOCK_AI_KEY_<ID>}` 占位符。旧版明文在启动时
  自动搬迁，搬不动就原样留着重试（绝不丢用户的密钥）。读钥匙串是同步阻塞调用，必须放在第一个
  `await` 之前；Linux 无 Secret Service 时报明原因，不静默降级成「没密钥」。
- 破坏性确认框自研（WKWebView 不支持 `window.confirm`）；右边栏内容面板 `hidden` 藏着不卸载；
  调试用 AI 参数覆盖只在 debug 构建（`dev.rs`），别用 `dotenvy`（`set_var` 会泄密钥进 PTY）。
- 远程连接（`remote.rs`）：SSH 走纯 Rust 的 `russh` + `russh-sftp`。交互式 shell 由**一个** tokio 任务
  独占通道（`wait()` 要 `&mut`，而 `data`/`window_change` 只要 `&self`——拆成两个任务就够不到改尺寸），
  前端指令走 mpsc 汇进同一个 `select!`。密码 / 私钥口令存系统钥匙串（前端只有布尔位），主机密钥按
  TOFU 记指纹、对不上就拒绝。**每台主机各自一组终端标签**，每个标签是一条独立 SSH 会话
  （`remote_connect` 自己建连 + 认证，不复用别的标签的连接），切走的主机与标签都 `display:none`
  藏着不卸载；会话 / 状态 / 重连计数都按标签 id 索引（不是按主机）。**关掉某台主机的最后一个标签
  就等于断开这台主机**（`connected` 不再单独存，由「有没有标签」派生）。`Ctrl+T` 新建 / `Ctrl+W`
  关闭和中间那个本地终端是**同一套键位**：各终端只在自己的容器上挂 keydown，谁拿到焦点谁响应。
- 远程连接的「文件」视图是**左右双面板**（`RemoteBrowser`）：本地（`local_fs.rs`）和远程（SFTP）各一个
  `FilePanel` 实例，选中文件传到对侧当前目录（只传文件，目录不递归）。**本地面板走 `local_fs` 的命令，
  刻意不查 `FsState` 工作区白名单**——它要像 WinSCP 那样自由浏览整个文件系统（主目录起、可一直退到
  「此电脑」列盘符）。这是本地桌面应用、前端即应用本体，且 `sftp_download` 本就写任意本地路径，风险
  可接受；这些命令只做文件管理、不做内容编辑。主机列表宽度与「本地/远程」左右顺序都是窗口级偏好，
  存 sessionStorage。两面板共用的界面在 `FilePanel.tsx`（纯展示），数据容器是 `RemoteFiles` / `LocalFiles`。
- 数据库（`database.rs`）：MySQL / PostgreSQL / SQLite 走 `sqlx`，**三库各持一个池**（`enum DbPool`）而不是
  用 `Any` 驱动——`Any` 的类型映射和 URL 解析都有限制，`*ConnectOptions` 的 builder 反而更干净（不拼 URL、
  不管转义）。TLS 特性必须是 `tls-rustls-aws-lc-rs`：reqwest / russh 已经在用 aws-lc，引 ring 会同时装
  两个 CryptoProvider，rustls 0.23 没显式装默认时直接 panic。**分页在服务端**：SELECT 类包一层
  `SELECT * FROM (<sql>) AS __codedock_pg LIMIT n+1 OFFSET m`，多取一行判断有没有下一页；写语句走
  `execute()` 报影响行数，SHOW/EXPLAIN 之类只取一页。单元格按「String → i64 → f64 → bool → 时间 → …」
  依次 `try_get` 渲染成字符串（sqlx 类型严格，`String` 解不了 INT）；BigDecimal / Uuid / JSON 只在
  MySQL / PG 上试——sqlx-sqlite 没有这些 `Decode` 实现，硬塞进同一个宏整个编不过。密码存系统钥匙串
  （前端只有布尔位），连接配置跨窗口共享。
- **单实例**：`tauri-plugin-single-instance` 在 builder 里**第一个**注册，回调把已被收进托盘的
  主窗口唤回来（`tray::show_main`）。它的锁名取自 app identifier，所以 dev 和安装版不能共用
  `tauri.conf.json` 里那个 `com.codedock`——否则本机开着安装版时 dev 一启动就被顶掉。build.rs 在
  debug profile 下用 `TAURI_CONFIG` 把 identifier patch 成 `com.codedock.dev`（CLI 可能也设了这个
  环境变量，得先读出来叠加、别整个覆盖），release 保持原值。改动的是**编译期配置**，所以直接
  `cargo build`/`cargo test` 也是 `.dev`。
- **dev / 安装版图标配色区分**：同一处 debug 分支还 patch 了 `bundle.icon`，指向 `icons/dev/` 那套
  （琥珀橙尖括号，源文件 `icons/icon-dev.svg`），安装版用 `icons/` 下的蓝色。exe 资源图标与窗口图标
  都取自 `bundle.icon`，所以任务栏 / 托盘一眼能分清哪个是开发构建。改了 `icon-dev.svg` 要
  `npx tauri icon icons/icon-dev.svg -o icons/dev` 重新生成，并 `touch build.rs`（tauri-build 的
  rerun-if-changed 不覆盖 icons 目录）。

## 验证

前端改完至少跑 `pnpm build`（Vite dev 不做类型检查）；界面改动走 `scripts/cdp-check.cjs`（WebView2 的
CDP 端口做截图 / 求值 / 输入）——**用法见 `.codebuddy/skills/cdp-verify/` 技能（前提、选项表、配方、排障）**；
要指定窗口可以传 `"target":"<标题片段>"`，脚本会跳过 WebView2 那个
内部的 about:blank target，**别拿 `pages[0]` 当目标窗口**，否则命令全打在空白页上。注意：`localStorage`
是用户真实状态、验证后要还原；拖动必须走 `drag`
而非合成 PointerEvent（应用用 `setPointerCapture`）；应用起没起来看 9222 端口。dev 下改工作区内任意
文件会触发 HMR 重载（终端重置、编辑器清空），是 dev server 产物，用 CodeDock 开发 CodeDock 时换工作区。
