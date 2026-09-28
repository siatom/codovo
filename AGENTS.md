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
  dev 构建和安装版靠**窗口标题 / 设置面板里的 `(dev)` 标记**区分，不带进版本号本身——
  Windows 的 exe 版本资源只接受纯 `x.y.z`。
- 没有用户明确允许，不要 `git push` / 开 PR / 推分支；提交留在本地等确认。

## 关键实现决定

> 都是踩过坑才定下来的，改之前先弄清为什么。

- 终端输出传**原始字节**、后端不解码（`read()` 会截断多字节 UTF-8）；非当前会话 `display:none` 藏而不卸载
  （卸载会杀 shell）；换工作区靠重开 shell、前后端根目录一起换；容器不设 padding 且 `overflow-clip`。
- **单窗口多项目**：一个窗口里同时开着多个项目，侧栏点哪个、右侧（终端 / 智能体 / 右边栏）就切到哪个。
  切走的项目**在后台继续跑**（shell 不杀、opencode 不停），切回来时终端会话、编辑器标签、文件树展开态
  原样还原。做法是**每个项目挂一个 `ProjectWorkspace` 实例**，非当前的 `display:none` 藏着不卸载——
  和 TerminalSession 的会话切换同一套路，状态天然保留，所以**别用 `key={root}` 之类重置它**。
- 后端状态**一律按项目 root 分片**（`FsState` / `WatchState` / `AgentState` / `PtyState`），命令显式收
  `root: String`；`FsState` 只认「登记过的根」当白名单，否则前端能拿任意路径去读写。事件走全局 `emit`，
  agent 的 payload 是 `{root, event}`，前端按 root 路由。agent 的 `config_dir` 用
  `project_dir_name(root)`（非法字符替换 + 稳定 hash）：共用一份会让两个 opencode 争用，而且收掉某个
  项目时的 `remove_dir_all` 会删掉别项目的目录。关项目走 `project_close`，一次收掉它的 shell、opencode
  与目录监听。目录监听**只跟当前项目**，切项目时整体换掉。
- 持久化的分层：**窗口级偏好存 sessionStorage**（侧栏折叠、CLI 选择）；**项目级的按 root 作 key**
  （右栏模块、浏览器地址、提交历史视图 / 高度、agent 当前会话）；**跨窗口共享的留 localStorage**
  （设置、主题、工作区列表、别名）并靠 `storage` 事件同步（只在别的 document 触发，不会自回流）；
  列表类一律「写前读最新 → 合并去重 → 写」，直接覆盖会抹掉别处刚写进去的。
- 多项目下的前端约定：git 状态**只轮询当前项目**（`useGitStatus(root, visible)`，隐藏的项目停轮询但
  保留状态）；Monaco 从隐藏切回可见要补一次 `layout()`（隐藏期间容器尺寸是 0）；侧栏命令、编辑器浮窗
  这类「打到当前项目实例」的动作，走 App 里的 `root -> handle` 表路由。
- 文件路径一律词法归一化 + 前缀校验，已存在的再 `canonicalize` 挡软链接逃逸；文件树改名 / 删除
  要带着编辑器标签一起换或关，改名前先落盘；工作区根禁改禁删。
- 目录监听只推「哪个父目录变了」，编辑器重读另走 `fs-file-changed`；防抖 300ms 并跳过 `SKIP_DIRS`。
- 差异基线照 VS Code（暂存 `HEAD↔index`、未暂存 `index↔工作区`），两侧统一按 LF 比较；差异编辑器
  懒创建、只读、不参与脏标记，三种差异靠 model URI 的 scheme 段区分。
- git 状态走 `status --porcelain=v2 --branch -z`；工作区可能只是仓库子目录，先 `rev-parse --show-prefix`；
  轮询命令带 `--no-optional-locks`（写操作不带）、Windows 上加 `CREATE_NO_WINDOW`；暂存带
  `--literal-pathspecs`、「全部暂存」给 `.`。
- AI / 智能体：HTTP 与 SSE 全走 Rust 代理，前端不直连 opencode；规则 / 记忆 / 技能 / Agents
  存 localStorage、启动时才物化；兼容两代接口、按接口探测（判据是响应里有 `version` 字段）。
- API 密钥进**操作系统凭据库**（`secrets.rs` + keyring），localStorage 只留 `apiKeySet` 布尔位，
  前端全程拿不到明文；opencode 配置里只有 `{env:CODEDOCK_AI_KEY_<ID>}` 占位符。旧版明文在启动时
  自动搬迁，搬不动就原样留着重试（绝不丢用户的密钥）。读钥匙串是同步阻塞调用，必须放在第一个
  `await` 之前；Linux 无 Secret Service 时报明原因，不静默降级成「没密钥」。
- 破坏性确认框自研（WKWebView 不支持 `window.confirm`）；右边栏内容面板 `hidden` 藏着不卸载；
  调试用 AI 参数覆盖只在 debug 构建（`dev.rs`），别用 `dotenvy`（`set_var` 会泄密钥进 PTY）。

## 验证

前端改完至少跑 `pnpm build`（Vite dev 不做类型检查）；界面改动走 `scripts/cdp-check.cjs`（WebView2 的
CDP 端口做截图 / 求值 / 输入）；要指定窗口可以传 `"target":"<标题片段>"`，脚本会跳过 WebView2 那个
内部的 about:blank target，**别拿 `pages[0]` 当目标窗口**，否则命令全打在空白页上。注意：`localStorage`
是用户真实状态、验证后要还原；拖动必须走 `drag`
而非合成 PointerEvent（应用用 `setPointerCapture`）；应用起没起来看 9222 端口。dev 下改工作区内任意
文件会触发 HMR 重载（终端重置、编辑器清空），是 dev server 产物，用 CodeDock 开发 CodeDock 时换工作区。
