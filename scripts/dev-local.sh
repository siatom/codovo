#!/usr/bin/env bash
# 起 dev 模式，并在 dev 退出后兜底清场。
#
# 为什么要在外面包一层：tauri CLI 正常退出时会一并收掉自己起的 vite，
# 但 CLI 被强杀（工具回收、终端被直接关掉）时 vite 会变成孤儿进程占着 5273，
# 下一次 pnpm tauri dev 会因为端口被占直接失败。这里把「跑 dev」和
# 「退出后清场」串进同一个进程，用户关掉 dev 窗口后由它收尾，保证不留占用。
#
# 用法：bash scripts/dev-local.sh [额外的 pnpm tauri dev 参数...]
#
# 运行时输出一律用英文：Git Bash 把 stdout 重定向到文件时中文会变成乱码，
# 日志就没法看了（注释照常写中文，注释不输出）。

set -u

cd "$(dirname "$0")/.." || exit 1

# 取当前占着 5273 的监听进程 PID（多个用换行分隔）
listening_pids() {
  netstat -ano | grep ':5273' | grep -i 'LISTENING' | awk '{print $NF}' | sort -u
}

# 启动前先记下端口是不是已经被别人占了。如果一开始就占着，说明占它的不是我们
# （这一轮根本起不来），cleanup 就别动它，免得误杀别的项目起的 vite；
# 本项目自己上一次的残留由命令层的「启动前清障」负责收拾。
preexisting="$(listening_pids)"

# 收掉还占着 5273 的进程（正常退出时这里通常已经是空的）
cleanup() {
  if [ -n "$preexisting" ]; then
    echo "[dev-local] cleanup: 5273 was already held before start (PIDs: $(echo $preexisting)), leaving it alone"
    return
  fi
  local pids
  pids="$(listening_pids)"
  if [ -z "$pids" ]; then
    echo "[dev-local] cleanup: port 5273 already free"
    return
  fi
  for pid in $pids; do
    echo "[dev-local] cleanup: killing PID=$pid (still holding 5273)"
    # //F //PID 的双斜杠是 Git Bash 的转义，避免 MSYS 把 /F 当路径转换
    taskkill //F //PID "$pid" >/dev/null 2>&1 \
      || echo "[dev-local] cleanup: kill PID=$pid failed (probably already gone)"
  done
}

echo "[dev-local] starting pnpm tauri dev ..."
pnpm tauri dev "$@"
code=$?
echo "[dev-local] pnpm tauri dev exited (code=$code), cleaning up"
cleanup
echo "[dev-local] cleanup done"
