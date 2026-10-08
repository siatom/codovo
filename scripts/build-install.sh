#!/usr/bin/env bash
# 构建 release 版 NSIS 安装包，并静默安装到本机。
#
# 用法：bash scripts/build-install.sh [--no-build] [--no-install]
#   --no-build   跳过构建，直接安装已存在的安装包（复用上一次产物）
#   --no-install 只构建，不安装
#
# 几个绕不开的坑：
# - NSIS 的静默开关是 /S，而 Git Bash 会把 /S 当路径去转换，所以写成 //S
#   （MSYS 会剥掉一个斜杠还原成 /S，同 dev-local.sh 里的 taskkill //F）。
# - 安装版 identifier 是 com.codedock、dev 版是 com.codedock.dev，两者并存不冲突；
#   但安装会覆盖本机已有的安装版——正在运行的实例会被安装器静默结束。
# - corepack 的 pnpm shim 在没有控制台的后台会话里会因设置进程标题失败而崩
#   （Assertion failed: process_title），前台无碍、后台必崩；改成 node 直跑
#   corepack 缓存里的 pnpm.cjs，前后台都稳。见 run_pnpm。
#
# 运行时输出一律用英文：Git Bash 把 stdout 重定向到文件时中文会变成乱码
# （注释照常写中文，注释不输出）。

set -u

cd "$(dirname "$0")/.." || exit 1

usage() {
  echo "usage: bash scripts/build-install.sh [--no-build] [--no-install]"
  echo "  --no-build    skip the build, install the existing bundle"
  echo "  --no-install  build only, do not install"
}

do_build=1
do_install=1
for arg in "$@"; do
  case "$arg" in
    --no-build)   do_build=0 ;;
    --no-install) do_install=0 ;;
    -h|--help)    usage; exit 0 ;;
    *) echo "[build-install] unknown option: $arg" >&2; usage; exit 2 ;;
  esac
done

case "$(uname -s 2>/dev/null)" in
  MINGW*|MSYS*|CYGWIN*) os=windows ;;
  Darwin*)               os=macos ;;
  *)                     os=linux ;;
esac

# 调 pnpm：优先用 node 直跑 corepack 缓存里的 pnpm.cjs（见文件头注释）。
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

if [ "$do_build" = 1 ]; then
  echo "[build-install] building release NSIS bundle (runs pnpm build + cargo build) ..."
  if ! run_pnpm tauri build --bundles nsis; then
    echo "[build-install] build failed" >&2
    exit 1
  fi
fi

nsis_dir="src-tauri/target/release/bundle/nsis"
setup="$(ls -t "$nsis_dir"/*-setup.exe 2>/dev/null | head -n1)"
if [ -z "$setup" ]; then
  echo "[build-install] no installer found under $nsis_dir" >&2
  exit 1
fi
echo "[build-install] installer: $setup"

if [ "$do_install" = 0 ]; then
  echo "[build-install] --no-install given, stopping after build"
  exit 0
fi

if [ "$os" != windows ]; then
  echo "[build-install] NSIS installer is Windows-only; skipping install" >&2
  exit 0
fi

if tasklist //FI "IMAGENAME eq codedock.exe" 2>/dev/null | grep -qi 'codedock.exe'; then
  echo "[build-install] WARNING: codedock.exe is running; the installer will close it"
fi

echo "[build-install] installing silently ..."
"$setup" //S
code=$?
if [ "$code" -ne 0 ]; then
  echo "[build-install] installer exited with code $code" >&2
  exit "$code"
fi

# currentUser 模式装到 %LOCALAPPDATA%\CodeDock；换过 installMode 的话这里验不到，
# 只提示、不当失败。
localappdata_u="$(cygpath -u "${LOCALAPPDATA:-$HOME/AppData/Local}" 2>/dev/null || echo "${LOCALAPPDATA:-$HOME/AppData/Local}")"
installed="$localappdata_u/CodeDock/codedock.exe"
if [ -f "$installed" ]; then
  echo "[build-install] installed: $installed"
else
  echo "[build-install] install finished (path not verified: $installed)"
fi
