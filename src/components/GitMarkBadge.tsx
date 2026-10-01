import type { GitMark, GitMarkKind } from "../lib/git";

const COLOR: Record<GitMarkKind, string> = {
  modified: "text-warn",
  added: "text-ok",
  untracked: "text-ok",
  deleted: "text-danger",
  conflict: "text-danger",
};

const TITLE: Record<GitMarkKind, string> = {
  modified: "有未提交的更改",
  added: "新增（已暂存）",
  untracked: "未跟踪的新文件",
  deleted: "已删除",
  conflict: "有合并冲突",
};

/** 文件树和编辑器标签页共用的 git 标记：一个字母 + 语义色 */
export function GitMarkBadge({ mark, className = "" }: { mark: GitMark; className?: string }) {
  return (
    <span
      title={TITLE[mark.kind]}
      className={`shrink-0 font-medium ${COLOR[mark.kind]} ${className}`}
    >
      {mark.label}
    </span>
  );
}

/**
 * 目录节点用的状态点：同一个语义色，但做成圆点而不是字母——目录不是具体某个
 * 改动，标一个字母会让人以为它自己有什么状态。尺寸由调用处用 className 给。
 */
export function GitMarkDot({ mark, className = "" }: { mark: GitMark; className?: string }) {
  return (
    <span
      title={TITLE[mark.kind]}
      className={`shrink-0 rounded-full bg-current ${COLOR[mark.kind]} ${className}`}
    />
  );
}
