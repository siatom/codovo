# ADR-006：复用 FsState 和 Git Worktree 能力，新增平台归属与租约

- 状态：accepted for M2
- 日期：2026-10-24
- 相关任务：CODO-003、CODO-206 至 CODO-208

## 背景

现有文件访问已通过 `FsState` 根白名单和 `resolve` 做边界校验，Git 已支持 worktree、状态、审查和合并。重新实现路径或 Git 会产生安全分叉。

## 决定

平台 Workspace/Repository/Worktree 服务调用现有命令和检查；新增平台表记录 `owned_by_codovo`、租约、baseline/final SHA、dirty 状态和 Run 关联。陌生或 dirty worktree 默认只读，不自动删除。

## 后果

任务执行能复用现有多根工作区和工作树雷达；删除/回收需要额外确认和所有权判断，不能把任意 Git worktree 当成平台临时资源。
