# ADR-007：凭据留在系统凭据库，Profile 只保存引用和非敏感覆盖

- 状态：accepted
- 日期：2026-10-24
- 相关任务：CODO-003、CODO-103

## 背景

现有 `secrets.rs` 使用 `keyring`，前端设置和 Agent 配置同时包含命令、模型、环境变量和服务地址。把环境快照整体落进平台 DB 可能泄露 token。

## 决定

Agent Profile 只持久化名称、CLI、参数、工作目录、允许的非敏感环境变量和 credential reference。Secret 值继续走 OS keyring；诊断、事件和 fixture 输出默认脱敏，不把进程环境完整复制到日志。

## 后果

Profile 可复现但不能独立导出密钥；跨机器迁移需要用户重新配置凭据。对无法强制的 CLI 内部权限明确显示限制。
