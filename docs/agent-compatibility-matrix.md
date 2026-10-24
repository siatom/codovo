# Agent CLI 能力探测矩阵

> 对应开发计划：CODO-002（CLI 能力探测实验）
> 依赖：CODO-000
> 探测日期：2026-10-24
> 方法：只执行 `--version` 和 `--help`，不启动模型、不修改配置、不读取或写入凭据。

## 1. 主机探测结果

| Agent | PATH 命令 | 版本 | 路径 | 基础状态 | 认证状态 |
| --- | --- | --- | --- | --- | --- |
| Claude Code | `claude` | `2.1.308 (Claude Code)` | `D:\DevEnv\Runtimes\Node\npm-global\claude.ps1` | `verified` | `unknown`，未读取凭据 |
| Codex CLI | `codex` | `codex-cli 0.163.0` | `D:\DevEnv\Runtimes\Node\npm-global\codex.ps1` | `verified` | `unknown`，未读取凭据 |
| OpenCode | `opencode` | `opencode v2.1.4` | `D:\DevEnv\Runtimes\Node\npm-global\opencode.ps1` | `verified` | `unknown`，未读取凭据 |
| CodeBuddy | `codebuddy` | `2.174.0` | `D:\DevEnv\Runtimes\Node\npm-global\codebuddy.ps1` | `verified` | `unknown`，未读取凭据 |

`verified` 只表示命令存在且能返回版本/帮助；不表示已登录、模型可调用或具备某种结构化协议。

## 2. 能力证据

| Agent | PTY/TUI | 非交互/结构化线索 | Session/恢复线索 | 权限线索 | 结论 |
| --- | --- | --- | --- | --- | --- |
| Claude Code | `claude` 默认启动 interactive session | `-p/--print`；帮助包含 `--output-format`、`stream-json` 相关选项 | `--continue`、`--resume`、后台 `--bg/--background` | `--allowed-tools`；存在 `--dangerously-skip-permissions`，禁止作为默认策略 | L1 已确认；L2/恢复参数已见于 help，仍需 fixture/官方文档验证 |
| Codex CLI | 默认 interactive CLI | `codex exec` 子命令存在；本次无 TTY 时 help 被 CLI 拒绝，未宣称 JSON 能力 | `agents` 子命令存在；Native session 语义未确认 | 不能从本次 help 证明安全审批行为 | L1 已确认；L2/L3 和权限待专门探测 |
| OpenCode | CLI 默认交互模式 | `--standalone`、`--server`；版本为 v2，当前 Codovo 已有 v1/v2 HTTP/SSE 兼容逻辑 | 当前仓库 `agent.rs` 已实现 session API、SSE、abort、list；外部 CLI 能力仍待独立验证 | 当前帮助未证明审批回调；Codovo 现有服务使用本地密码/隔离配置 | L3 的本地 Server 路径已有代码证据；需运行时健康和错误矩阵 |
| CodeBuddy | 默认 interactive session | `--print`、`--output-format json/stream-json`、`--input-format stream-json`、`--serve`、`--acp` | `--continue`、`--resume`、`--session-id`、`--no-session-persistence` | `--permission-mode`；`-y/--dangerously-skip-permissions` 明确高风险，禁止默认开启 | L2/ACP 线索已确认；取消、审批和版本兼容仍需 fixture |

## 3. 实际执行命令

```text
claude --version
claude --help
codex --version
codex --help
opencode --version
opencode --help
codebuddy --version
codebuddy --help
```

附加帮助探测：

```text
claude --help
codex exec --help       # 当前终端 TERM=dumb 时 CLI 拒绝进入确认 TUI，未将失败当作能力结论
opencode --help         # 子命令帮助需在有 TTY/正确参数路由的环境进一步验证
codebuddy --help
```

## 4. 认证与安全边界

本轮没有执行 `login`、token 查询、网络请求或模型调用，因此四家认证状态均为 `unknown`。后续 Registry 应把 `unknown` 与 `ready` / `needs_login` 区分，不能把命令存在误报为认证就绪。

已观察到的危险开关：

- Claude：`--dangerously-skip-permissions`；
- CodeBuddy：`-y/--dangerously-skip-permissions`；
- 其它 CLI 的等价绕过参数必须在 CODO-002 后续探测中单独记录。

Codovo 不应为取得非交互输出而默认注入这些开关。没有官方审批回调时，只提供 PTY 或已声明能力的降级状态。

## 5. 下一轮验证矩阵

| 验证项 | 当前状态 | 后续证据 |
| --- | --- | --- |
| 可执行路径/版本 | `verified` | 本文表格和命令输出 |
| 认证是否就绪 | `unknown` | CODO-102 通过不暴露密钥的 CLI 状态探测 |
| 结构化事件 | Claude/CodeBuddy 有 help 线索；Codex/OpenCode 未完成 | Fake CLI + 各家最小非交互命令 |
| Session resume | Claude/CodeBuddy help 有参数；OpenCode 代码已有 API；Codex 未确认 | 原生 Session ID/恢复烟测 |
| 取消/停止 | 未确认 | 每家独立进程生命周期测试 |
| 审批回调 | 未确认 | 官方 API/SDK 或安全 fixture；不解析 TUI 猜测 |
| 多目录权限 | Claude/CodeBuddy `--add-dir` 已见；其余待确认 | CODO-103 profile 注入测试 |

## 6. 交付摘要

```yaml
task_id: CODO-002
result: completed
summary: 完成 Claude/Codex/OpenCode/CodeBuddy CLI 的路径、版本、帮助和安全线索探测
changed_files:
  - docs/agent-compatibility-matrix.md
tests:
  - command: claude/codex/opencode/codebuddy --version 与 --help
    result: passed
decisions:
  - 命令存在不等于认证就绪，认证状态保留 unknown
  - 未对危险免审批参数做默认注入
  - 未经运行时验证不宣称取消、审批或跨版本恢复能力
risks:
  - Codex/OpenCode 子命令 help 受 TTY/参数路由影响，需后续专门烟测
next_tasks:
  - CODO-003
  - CODO-102
```
