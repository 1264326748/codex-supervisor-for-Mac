#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="任务主管控制台.app"
APP_TARGET="$HOME/Applications/$APP_NAME"
LOG_FILE="/tmp/codex-supervisor-desktop-launcher.log"
BUILD_LOG="/tmp/codex-supervisor-desktop-build.log"

mkdir -p "$HOME/Applications"

# 保证渲染端资源是最新的
cd "$PROJECT_DIR"
pnpm build >"$BUILD_LOG" 2>&1

# 不能用 node_modules/.bin/electron（它依赖 PATH 里的 node）
ELECTRON_BIN="$(node -e "console.log(require('electron'))")"
if [[ ! -x "$ELECTRON_BIN" ]]; then
  echo "未找到可执行 Electron 二进制：$ELECTRON_BIN" >&2
  exit 1
fi

# Finder 环境 PATH 很干净，这里强制补齐常见 bin 目录
BOOT_PATH='/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.bun/bin:$HOME/.npm-global/bin'

LAUNCH_CMD="export PATH=$BOOT_PATH; cd '$PROJECT_DIR' && nohup '$ELECTRON_BIN' '$PROJECT_DIR/electron/main.js' >'$LOG_FILE' 2>&1 &"

/usr/bin/osacompile -o "$APP_TARGET" <<OSA
on run
  do shell script "$LAUNCH_CMD"
end run
OSA

echo "已生成应用：$APP_TARGET"
echo "双击即可启动，无需在终端执行 pnpm dev。"
echo "若打开后立刻退出，请查看日志：$LOG_FILE"
