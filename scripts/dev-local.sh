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
# 三端通用：端口探测和杀进程按 uname 分支——Windows 走 netstat/taskkill，
# macOS/Linux 走 lsof（没装 lsof 时退到 ss）/ kill。
#
# 运行时输出一律用英文：Git Bash 把 stdout 重定向到文件时中文会变成乱码，
# 日志就没法看了（注释照常写中文，注释不输出）。

set -u

cd "$(dirname "$0")/.." || exit 1

case "$(uname -s 2>/dev/null)" in
  MINGW*|MSYS*|CYGWIN*) os=windows ;;
  Darwin*)               os=macos ;;
  *)                     os=linux ;;
esac

# 取当前占着 5273 的监听进程 PID（多个用换行分隔）
listening_pids() {
  case "$os" in
    windows)
      # Windows netstat 的最后一列就是 PID
      netstat -ano | grep ':5273' | grep -i 'LISTENING' | awk '{print $NF}' | sort -u
      ;;
    *)
      if command -v lsof >/dev/null 2>&1; then
        # -t 只输出 PID，省去解析列；-n -P 免得反查域名/端口名拖慢
        lsof -nP -iTCP:5273 -sTCP:LISTEN -t 2>/dev/null | sort -u
      else
        # 退而求其次：ss 要 -p 才带 pid，非 root 只看得到属于自己的进程
        ss -ltnp 2>/dev/null | grep ':5273' \
          | sed -n 's/.*pid=\([0-9]\{1,\}\).*/\1/p' | sort -u
      fi
      ;;
  esac
}

# 停掉单个 PID。Unix 上先 TERM 给 vite 留个收尾的机会，赖着不走再 KILL。
kill_pid() {
  case "$os" in
    windows)
      # //F //PID 的双斜杠是 Git Bash 的转义，避免 MSYS 把 /F 当路径转换
      taskkill //F //PID "$1" >/dev/null 2>&1
      ;;
    *)
      kill -TERM "$1" 2>/dev/null || return 0
      local i
      for i in 1 2 3 4 5 6 7 8 9 10; do
        kill -0 "$1" 2>/dev/null || return 0
        sleep 0.3
      done
      kill -KILL "$1" 2>/dev/null
      ;;
  esac
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
    kill_pid "$pid" \
      || echo "[dev-local] cleanup: kill PID=$pid failed (probably already gone)"
  done
}

echo "[dev-local] os=$os, starting pnpm tauri dev ..."
pnpm tauri dev "$@"
code=$?
echo "[dev-local] pnpm tauri dev exited (code=$code), cleaning up"
cleanup
echo "[dev-local] cleanup done"
