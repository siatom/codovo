# ADR-003：Runtime Supervisor 包裹现有 PTY，适配器按能力降级

- 状态：accepted for M1
- 日期：2026-10-24
- 相关任务：CODO-003、CODO-104 至 CODO-106

## 背景

`PtyState` 已提供真实 shell 的 spawn/write/resize/kill；Agent 目前同时存在 PTY CLI 和 opencode HTTP/SSE 两条路径。不能因为统一接口而删除原生终端。

## 选项

1. 仅保留 PTY，并从 TUI 文本推断工具事件。
2. 为每个 Agent 重写一套完全独立进程管理。
3. 以 Supervisor/Adapter 接口统一生命周期，PTY 作为 L1 Adapter，结构化 API 按探测结果接入。

## 决定

选 3。Supervisor 负责意图、资源释放、超时和对账；Adapter 负责 Native Handle、输入、取消、事件和能力。禁止从字符流伪造工具/审批事件。

## 后果

旧终端保持兼容，能力不足时仍可用；Adapter 需要明确 `structuredEvents`、`sessionResume`、`approvalCallback` 等能力，未知默认为 false。
