#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/service-common.sh"

if ! pid="$(read_pid 2>/dev/null)"; then
  clear_stale_pid
  echo "Browser Reader 未运行。"
  exit 0
fi
if ! is_owned_process "$pid"; then
  clear_stale_pid
  echo "Browser Reader 未运行。"
  exit 0
fi

kill "$pid" 2>/dev/null || true
for _ in {1..25}; do
  if ! kill -0 "$pid" 2>/dev/null; then
    clear_stale_pid
    echo "Browser Reader 已停止。"
    exit 0
  fi
  sleep 0.2
done
if is_owned_process "$pid"; then
  kill -9 "$pid" 2>/dev/null || true
fi
clear_stale_pid
echo "Browser Reader 已停止。"
