#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/service-common.sh"

if ! pid="$(read_pid 2>/dev/null)"; then
  clear_stale_pid
  echo "Browser Reader 未运行。"
  exit 1
fi
if ! is_owned_process "$pid"; then
  clear_stale_pid
  echo "Browser Reader 未运行。"
  exit 1
fi
if health_ok; then
  echo "Browser Reader 运行中且健康 (pid $pid)。"
  exit 0
fi
echo "Browser Reader 运行中但健康检查失败 (pid $pid)。"
exit 1
