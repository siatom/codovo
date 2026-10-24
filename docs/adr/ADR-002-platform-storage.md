# ADR-002：平台元数据使用独立 SQLite，不复用用户数据库或 opencode 数据库

- 状态：accepted for M1
- 日期：2026-10-24
- 相关任务：CODO-003、CODO-107

## 背景

现有 `database.rs` 的 SQLite/MySQL/PostgreSQL 连接池服务用户数据库工具；opencode 维护自己的 Native Session 库。两者都不属于 Codovo 控制面数据。

## 选项

1. 把 Task/Run 写入用户项目数据库。
2. 直接读取/扩展 opencode 内部数据库。
3. 使用应用配置目录下独立 SQLite，迁移由 Codovo 管理。

## 决定

选 3。复用已存在的 `sqlx` SQLite 驱动，新增平台 migration、schema version、WAL/FK 和事务边界；路径按 Tauri `app_data_dir` 管理。

## 后果

平台数据可跨项目统一查询、可迁移和备份；需要定义旧版本升级和损坏恢复。用户数据库连接和 Native Session 只通过显式映射读取，不把厂商 schema 当公共契约。
