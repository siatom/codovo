# ADR-004：Task、Run、Session 和 Event 使用独立标识与映射

- 状态：accepted for M1/M2
- 日期：2026-10-24
- 相关任务：CODO-003、CODO-101、CODO-108、CODO-109

## 背景

PTY id 是短生命周期整数，opencode Native Session 由厂商维护；当前仓库没有平台 Task/Run。把它们混成一个 ID 会损失重试、交接和审计能力。

## 决定

平台新增 `TaskId`、`RunId`、`CodovoSessionId`、`EventId`；Native Session 只作为 `SessionLink` 引用。一个 Task 可以有多个 Run，一个 Run 可以关联主 Session 和子 Session。事件采用 `schemaVersion/eventKey/source/sequence/payload` Envelope。

## 后果

Run 成功不自动等于 Task 完成；取消、进程退出、Turn 完成和人工验收保持独立事件。需要幂等键和至少一次投递语义，避免重复 SSE 或 UI 重试产生重复记录。
