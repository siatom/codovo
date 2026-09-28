#!/usr/bin/env bash
# 起 dev 模式，并在 dev 退出后兜底清场。
#
# 为什么要在外面包一层：tauri CLI 正常退出时会一并收掉自己起的 vite，
# 但 CLI 被强杀（工具回收、终端被直接关掉）时 vite 会变成孤儿进程占着 5273，
# 下一次 pnpm tauri dev 会因为端口被占直接失败。这里把「跑 dev」和
# 「退出后清场」串进同一个进程，用户关掉 dev 窗口后由它收尾，保证不留占用。
#
# 用法：bash scripts/dev-local.sh [额外的 pnpm tauri dev 参数...]

set -u

cd "$(dirname "$0")/.." || exit 1

# 收掉还占着 5273 的进程（正常退出时这里通常已经是空的）
cleanup() {
  local pids
  pids="$(netstat -ano | grep ':5273' | grep -i 'LISTENING' | awk '{print $NF}' | sort -u)"
  if [ -z "$pids" ]; then
    echo "[dev-local] 清场：5273 已释放，无残留"
    return
  fi
  for pid in $pids; do
    echo "[dev-local] 清场：收掉占用 5273 的进程 PID=$pid"
    # //F //PID 的双斜杠是 Git Bash 的转义，避免 MSYS 把 /F 当路径转换
    taskkill //F //PID "$pid" >/dev/null 2>&1 \
      || echo "[dev-local] 清场：停止 PID=$pid 失败（多半已经自己退了）"
  done
}

echo "[dev-local] 启动 pnpm tauri dev ..."
pnpm tauri dev "$@"
code=$?
echo "[dev-local] pnpm tauri dev 已退出（exit=$code），开始清场"
cleanup
echo "[dev-local] 清场完成"
