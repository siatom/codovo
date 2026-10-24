# CODO-004 测试基线

> 执行日期：2026-10-24
> 工作树：`feat/codo-000-current-state`

## 命令结果

| 命令 | 结果 | 证据/说明 |
| --- | --- | --- |
| `node scripts/test-fake-agent.mjs` | passed | 输出 `fake agent lifecycle tests passed` |
| `pnpm.cmd build` | passed | TypeScript 检查与 Vite 生产构建完成；生成图标目录和 `dist` 均为忽略产物 |
| `pnpm.cmd test:translate` | passed | 输出 `translate split test passed` |
| `cargo test --lib` | blocked by environment | `aws-lc-sys v0.45.0` 的 MSVC `cl.exe` 编译 C 文件失败，错误为 `D8050`（无法将命令行放入调试记录）；不是 Rust 源码诊断 |
| `CARGO_BUILD_JOBS=1 cargo test --lib` | blocked by environment | 降为单作业后仍在 `aws-lc-sys` 的 `jitterentropy-*.c` 阶段得到相同 `D8050` |
| `cargo clippy` | not run | Rust 依赖尚未完成编译，先修复本机 C 编译器环境再执行 |

## Fake Adapter 覆盖

`scripts/test-fake-agent.mjs` 通过子进程启动 `scripts/fixtures/fake-agent.mjs`，验证：

- 正常启动、`agent.started`、`run.succeeded`、停止和子进程退出；
- 失败事件 `run.failed`；
- 慢任务收到取消后发出 `run.cancelled`；
- 相同 `eventKey` 重复发送，测试器保留重复事件供后续幂等层处理；
- 权限请求、拒绝决定和失败收敛；
- 事件使用 NDJSON、`schemaVersion`、`type` 和 `eventKey`，不依赖真实 Agent 或网络。

## 处理原则

Rust 基线失败已保留为环境阻塞证据，不把它改写为“测试通过”。M1 开始前应在可用的 Visual Studio C/C++ 编译环境中重新执行 `cargo test --lib` 和 `cargo clippy`，并把完整通过结果追加到本文件。
