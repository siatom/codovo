#!/usr/bin/env bash
# 热替换本机已安装的 Codovo——不关闭正在运行的实例，下次启动即新版本。
#
# 为什么不用安装器：NSIS 安装器要在安装目录覆盖 codovo.exe，而正在运行的 exe 被
# 系统锁住，安装器只能先把它结束（见 tauri-bundler 生成的 utils.nsh 里
# CheckIfAppIsRunning 宏：静默模式 IfSilent 直接走 KillProcess，连确认都不弹）。
#
# 而 Windows 允许「重命名」正在运行的 exe：把旧 exe 改成 codovo.exe.old——进程继续
# 用内存里的旧镜像跑，不受影响——再把新 exe 放到原路径。于是不关闭应用即可更新，
# 下次启动生效。代价：绕过了安装器，所以「应用和功能」里的版本号与 uninstall.exe
# 不会更新；回滚 = 把 .old 改回原名（见 --rollback）。
#
# 用法：bash scripts/hot-update.sh [选项]
#   --no-build        跳过构建，直接用已有的 src-tauri/target/release/codovo.exe
#   --rollback        用 codovo.exe.old 还原上一版本（需先关闭应用）
#   --dir <path>      指定安装目录（默认 %LOCALAPPDATA%\Codovo）
#   -h, --help        显示帮助
#
# 坑：重命名后的 codovo.exe.old 在应用运行期间仍被占用、删不掉，所以连续第二次
# 运行（还没重启过应用）时，脚本会自动改用带时间戳的备份名，不覆盖上一次的回滚点。
#
# 运行时输出一律用英文：Git Bash 把 stdout 重定向到文件时中文会变成乱码
# （注释照常写中文，注释不输出）。

set -u

cd "$(dirname "$0")/.." || exit 1

APP=codovo
BINARY="${APP}.exe"

usage() {
  echo "usage: bash scripts/hot-update.sh [--no-build] [--rollback] [--dir <path>]"
  echo "  --no-build     skip the build, reuse the existing release binary"
  echo "  --rollback     restore codovo.exe.old (close the app first)"
  echo "  --dir <path>   install directory (default: %LOCALAPPDATA%\\Codovo)"
}

do_build=1
do_rollback=0
install_dir=""

while [ $# -gt 0 ]; do
  case "$1" in
    --no-build)  do_build=0 ;;
    --rollback)  do_rollback=1 ;;
    --dir)       shift; install_dir="${1:-}" ;;
    -h|--help)   usage; exit 0 ;;
    *) echo "[hot-update] unknown option: $1" >&2; usage; exit 2 ;;
  esac
  shift
done

case "$(uname -s 2>/dev/null)" in
  MINGW*|MSYS*|CYGWIN*) os=windows ;;
  Darwin*)               os=macos ;;
  *)                     os=linux ;;
esac

if [ -z "$install_dir" ]; then
  install_dir="${LOCALAPPDATA:-$HOME/AppData/Local}/Codovo"
fi

# 安装目录是按 per-user NSIS 装的，只有 Windows 有这个约定；别的平台路径不同，
# 直接退出而不是去猜，免得改错地方。
if [ "$os" != windows ]; then
  echo "[hot-update] this script only handles the Windows NSIS install dir; aborting" >&2
  exit 1
fi

cur="$install_dir/$BINARY"

# 调 pnpm：优先用 node 直跑 corepack 缓存里的 pnpm.cjs（同 build-install.sh）。
# corepack 的 pnpm shim 在无控制台的后台会话里设进程标题会失败崩掉。
run_pnpm() {
  local base pnpm_cjs
  base="$(cygpath -u "${LOCALAPPDATA:-$HOME/AppData/Local}" 2>/dev/null || echo "${LOCALAPPDATA:-$HOME/AppData/Local}")"
  pnpm_cjs="$(ls -t "$base"/node/corepack/v1/pnpm/*/bin/pnpm.cjs 2>/dev/null | head -n1)"
  if [ -n "$pnpm_cjs" ] && command -v node >/dev/null 2>&1; then
    node "$pnpm_cjs" "$@"
  else
    pnpm "$@"
  fi
}

running_pids() {
  tasklist //FI "IMAGENAME eq $BINARY" //NH 2>/dev/null | awk '{print $2}' | grep -E '^[0-9]+$' | tr '\n' ' '
}

# 找最近一次的回滚点：优先定名 codovo.exe.old，否则取最新的时间戳备份。
newest_backup() {
  ls -t "$install_dir/$BINARY".old* 2>/dev/null | head -n1
}

if [ "$do_rollback" = 1 ]; then
  bak="$(newest_backup)"
  if [ -z "$bak" ]; then
    echo "[hot-update] no rollback point ($BINARY.old*) found in $install_dir" >&2
    exit 1
  fi
  echo "[hot-update] rolling back: $bak -> $cur"
  # 不先 rm cur：万一 rm 成功而随后的 mv 失败，两个文件就都没了。mv -f 直接覆盖更稳。
  # 注意 bak 是正在运行的镜像，重命名它本身是允许的（同热替换）。
  if ! mv -f "$bak" "$cur"; then
    echo "[hot-update] rollback failed (is the app running the current build?); close it and retry" >&2
    exit 1
  fi
  echo "[hot-update] rolled back to previous version"
  exit 0
fi

if [ "$do_build" = 1 ]; then
  echo "[hot-update] building release binary (pnpm tauri build --no-bundle) ..."
  if ! run_pnpm tauri build --no-bundle; then
    echo "[hot-update] build failed" >&2
    exit 1
  fi
else
  echo "[hot-update] --no-build given, reusing existing release binary"
fi

new_exe="src-tauri/target/release/$BINARY"
if [ ! -f "$new_exe" ]; then
  echo "[hot-update] no release binary at $new_exe" >&2
  exit 1
fi

if [ ! -f "$cur" ]; then
  echo "[hot-update] no installed binary at $cur (install once first, or use --dir)" >&2
  exit 1
fi

# 已经是最新就不折腾：省掉一次无意义的重命名。
if cmp -s "$new_exe" "$cur"; then
  echo "[hot-update] installed binary already matches the build; nothing to do"
  exit 0
fi

pids="$(running_pids)"
if [ -n "$pids" ]; then
  echo "[hot-update] app is running (PIDs: $pids); hot-swapping without closing it"
else
  echo "[hot-update] app is not running; swapping the installed binary"
fi

# 清理旧回滚点。删不掉说明它正被运行中的进程占用（上一轮换过、还没重启），
# 这时改用时间戳名，保住上一轮的回滚点。
bak="$install_dir/$BINARY.old"
if [ -e "$bak" ]; then
  if ! rm -f "$bak" 2>/dev/null; then
    bak="$bak.$(date +%Y%m%d%H%M%S)"
    echo "[hot-update] previous backup still locked, using $bak"
  fi
fi

# 关键一步：重命名运行中的 exe（Windows 允许），进程继续从内存里的旧镜像跑。
if ! mv "$cur" "$bak"; then
  echo "[hot-update] failed to rename the installed binary; aborting" >&2
  exit 1
fi
echo "[hot-update] backup: $bak"

if ! cp "$new_exe" "$cur"; then
  echo "[hot-update] failed to place the new binary; rolling back" >&2
  mv -f "$bak" "$cur"
  exit 1
fi

# Verify：逐字节比对 + 应用是否还在跑。
if ! cmp -s "$new_exe" "$cur"; then
  echo "[hot-update] verification failed (installed != built); rolling back" >&2
  mv -f "$bak" "$cur"
  exit 1
fi

echo "[hot-update] VERIFY_OK: installed binary is the new build"
if [ -n "$pids" ]; then
  echo "[hot-update] app still running (PIDs: $pids) on the old build; next launch picks up the new one"
fi
echo "[hot-update] rollback: bash scripts/hot-update.sh --rollback (close the app first)"
