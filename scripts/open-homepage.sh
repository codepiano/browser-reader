#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if ! "$SCRIPT_DIR/status.sh" >/dev/null 2>&1; then
  "$SCRIPT_DIR/start.sh"
fi
open "${BROWSER_READER_URL:-http://127.0.0.1:${PORT:-4321}}"
