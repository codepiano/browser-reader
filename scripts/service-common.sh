#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="$PROJECT_ROOT/.control-panel"
PID_FILE="$STATE_DIR/browser-reader.pid"
LOG_FILE="$STATE_DIR/logs/browser-reader.log"
SERVER_FILE="$PROJECT_ROOT/dist/server.js"
HEALTH_URL="${BROWSER_READER_HEALTH_URL:-http://127.0.0.1:${PORT:-4321}/api/health}"
mkdir -p "$STATE_DIR/logs"

read_pid() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid
  pid="$(tr -d '[:space:]' < "$PID_FILE")"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  printf '%s\n' "$pid"
}

process_command() { ps -p "$1" -o command= 2>/dev/null | sed 's/^[[:space:]]*//'; }

is_owned_process() {
  local pid="$1" command
  kill -0 "$pid" 2>/dev/null || return 1
  command="$(process_command "$pid")"
  [[ "$command" == *"$SERVER_FILE"* ]]
}

clear_stale_pid() { rm -f "$PID_FILE"; }
health_ok() { curl --silent --show-error --max-time 2 --fail "$HEALTH_URL" >/dev/null 2>&1; }
