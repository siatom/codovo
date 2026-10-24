# PTY / Session 调用链与回归基线

> 对应开发计划：CODO-001（现有 PTY/Session 流程追踪）
> 依赖：CODO-000
> 盘点日期：2026-10-24

## 1. 现有调用链

```text
TerminalPane
  -> src/lib/pty.ts::spawnPty
  -> invoke("pty_spawn", { root, cwd, shell, env, cols, rows, onEvent })
  -> src-tauri/src/pty.rs::pty_spawn
  -> open_shell -> portable_pty::native_pty_system -> shell process
  -> reader thread -> Channel<PtyEvent::Data { base64 }>
  -> xterm.js terminal.write(Uint8Array)
  -> waiter thread -> Channel<PtyEvent::Exit { code }>
  -> TerminalPane 更新退出状态并释放前端 handle
```

### 启动

1. `TerminalPane` 计算活动工作区 root、cwd、终端尺寸和可选 shell。
2. `spawnPty` 创建 Tauri `Channel<PtyEvent>`，把 `data` 事件从 base64 解码成字节后交给 xterm.js。
3. `pty_spawn` 调用 `open_shell`，设置 cwd、`TERM`/`COLORTERM` 和调用方提供的环境变量。
4. 后端先把 `PtySession` 登记进 `PtyState.sessions`，再启动 reader/waiter 线程，避免快速退出的 shell 留下泄漏条目。

### stdin / stdout

- 前端 `PtyHandle.write(data)` 调用 `pty_write`，后端写入并 flush PTY writer。
- reader 线程每次最多读取 8192 字节，原样 base64 编码；不在 Rust 中按 UTF-8 解码，避免多字节字符跨 read 边界损坏。
- Channel 断开时 reader 线程退出；这只代表 UI 通道断开，不应被解释为 Agent 成功结束。

### resize

`TerminalPane` 根据 xterm.js fit 结果调用 `PtyHandle.resize(cols, rows)`，后端对尺寸做最小值保护后调用 `MasterPty::resize`。resize 失败只回传 rejected Promise；前端现有调用会吞掉已销毁会话的异步错误。

### 退出与停止

- 子进程自然退出：waiter 线程发送 `Exit(code)`，随后从 `PtyState.sessions` 移除会话。
- 用户停止：前端调用 `pty_kill`；后端移除会话、调用 `ChildKiller::kill` 并释放 master，避免 ConPTY 子进程残留。
- 关闭工作区：`workspace_close` 调 `PtyState::kill_workspace(root)`，只清理该 root 的 PTY。
- 应用退出：`lib.rs` 的 `RunEvent::ExitRequested/Exit` 调 `PtyState::kill_all()`，同时清理 Agent、监听、远程、数据库、预览和 CICD 状态。

## 2. Session 语义现状

当前有三种互不等价的“会话”：

| 会话 | 标识 | 生命周期/持久化 | 当前能力 |
| --- | --- | --- | --- |
| PTY 会话 | `u32` | 进程内；退出或应用退出即清理 | 输入、输出、resize、kill、退出码 |
| 前端终端标签 | React 状态和工作区 session 存储 | 标签和激活项可恢复，进程本身不可恢复 | 绑定 PTY id、shell、cwd、标题 |
| opencode Native Session | 厂商返回的字符串 ID | 由 opencode 原生数据库维护 | 创建、列表、消息、abort、删除、重命名 |

Codovo 当前没有平台级 `CodovoSession`、`TaskRun` 或 `SessionLink` 表。后续实现必须保留上述原生标识，并通过显式映射关联，不能把 PTY id 或 Native Session ID 直接当成 Task ID。

## 3. 回归用例

| ID | 场景 | 可复现步骤 | 预期证据 |
| --- | --- | --- | --- |
| PTY-01 | 启动与 stdout | 启动自动 shell，在终端输入一条无副作用命令 | 收到非空 `Data`，xterm.js 显示输出 |
| PTY-02 | stdin 回写 | 输入 `echo`/PowerShell 等价命令并发送回车 | 命令进入 shell，输出按字节完整显示 |
| PTY-03 | resize | 调整终端面板尺寸 | `pty_resize` 成功；后续全屏 TUI 获得新尺寸 |
| PTY-04 | 自然退出 | 输入 `exit` 或等价命令 | 只收到一次 `Exit(code)`，会话从池移除 |
| PTY-05 | 用户停止 | 启动长时间命令并点击停止 | 进程被 kill；不把停止标记为成功 |
| PTY-06 | 工作区隔离 | 在两个工作区分别启动 shell，关闭其中一个 | 只清理被关闭 root 的会话，另一个继续运行 |
| PTY-07 | 应用退出 | 运行 shell 后退出应用 | `kill_all` 清理全部 PTY，不留下游离 shell |
| PTY-08 | 快速退出竞态 | 启动一个立即退出的 shell | waiter 不会在登记前删除 id；池中无残留会话 |
| SESSION-01 | Native Session | 启动 Agent 服务并创建会话 | 返回 Native Session ID；列表可见 |
| SESSION-02 | 取消与终止区分 | Agent turn 运行时分别 abort 和 stop PTY | 记录操作结果；不把 `abort` 或窗口关闭直接当作 Task 完成 |
| SESSION-03 | 重启对账 | 关闭应用后重启 | UI 元数据可恢复；不存在的进程标为未知/脱离，不能声称仍运行 |

## 4. 已有可执行回归

- `src-tauri/src/pty.rs::shell_roundtrip_through_pty`：启动真实 shell、写入命令、读取输出并验证 marker。
- `src-tauri/src/pty.rs` 还覆盖退出码、kill 和 session cleanup 的纯 Rust 路径。
- 界面级回归入口为 `scripts/cdp-check.cjs`，需要先启动带 CDP 端口的 Tauri 开发实例；本次没有启动窗口，因此未声称界面用例通过。

## 5. 接入新 Runtime 时的保留约束

1. 保留 `pty_spawn/write/resize/kill` 以及现有 xterm.js 行为，新增 Supervisor 只能包裹，不替换 L1 PTY。
2. `PtyEvent::Data` 继续传原始字节；结构化 Agent 事件必须走独立 Adapter/Event 通道，不能从终端字符流猜测。
3. 进程退出、Turn 完成、终端标签关闭和 Task 完成保持不同事件。
4. 所有新运行实例必须记录工作区 root，并复用 `workspace_close` / 应用退出的清理路径。
5. 任何恢复能力必须先探测并持久化 Native Session 关联；不支持恢复时显示 `detached/unknown`。

## 6. 交付摘要

```yaml
task_id: CODO-001
result: completed
summary: 追踪 PTY、终端标签和 opencode Native Session 的调用链并建立回归矩阵
changed_files:
  - docs/codovo-pty-session-flow.md
tests:
  - command: src-tauri 内置 shell_roundtrip_through_pty
    result: documented; runtime baseline recorded with CODO-004
decisions:
  - PTY 原始字节通道与结构化 Agent 事件分离
  - PTY id、终端标签和 Native Session 不互相替代
risks:
  - CODO-001 文档阶段未启动 Tauri 窗口，CDP 用例待环境可用时执行
next_tasks:
  - CODO-002
  - CODO-003
```
