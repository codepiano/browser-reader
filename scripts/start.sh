#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/service-common.sh"
cd "$PROJECT_ROOT"

if pid="$(read_pid 2>/dev/null)" && is_owned_process "$pid"; then
  echo "Browser Reader 已在运行 (pid $pid)。"
  exit 0
fi
clear_stale_pid
npm run build
if [[ ! -f "$SERVER_FILE" ]]; then
  echo "构建完成但未找到 $SERVER_FILE。" >&2
  exit 1
fi

nohup env PORT="${PORT:-4321}" node "$SERVER_FILE" >"$LOG_FILE" 2>&1 &
pid=$!
printf '%s\n' "$pid" > "$PID_FILE"
for _ in {1..20}; do
  if ! kill -0 "$pid" 2>/dev/null; then
    clear_stale_pid
    echo "Browser Reader 启动失败。请查看 $LOG_FILE。" >&2
    tail -n 40 "$LOG_FILE" >&2 || true
    exit 1
  fi
  if health_ok; then
    echo "Browser Reader 已启动 (pid $pid)。"
    exit 0
  fi
  sleep 0.2
done

if is_owned_process "$pid"; then
  echo "Browser Reader 已启动，但健康检查尚未通过 (pid $pid)。"
  exit 0
fi
clear_stale_pid
echo "Browser Reader 启动失败。请查看 $LOG_FILE。" >&2
tail -n 40 "$LOG_FILE" >&2 || true
exit 1
