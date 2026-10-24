# ADR-008：采用可回退的增量迁移和显式 Feature Flag

- 状态：accepted
- 日期：2026-10-24
- 相关任务：CODO-003、CODO-004、CODO-107

## 背景

当前产品已经有用户工作区、编辑器会话、原生 Agent 历史和终端行为。平台层尚未存在，不能要求一次迁移所有既有数据，也不能破坏原 PTY。

## 决定

新增平台数据库和 API 采用 additive migration；旧工作区/设置继续可读。新 Task/Run 路径在前端和后端保留显式 feature flag，默认先支持手工流程；PTY fallback 永远可用。迁移失败时只阻止平台层，不删除原有配置和 Native Session。

## 后果

可以逐步上线并回退，代价是短期存在两套 UI 状态和迁移代码。每个版本要记录 schema version、兼容窗口和恢复步骤，不能用 reset 或静默覆盖用户数据。
