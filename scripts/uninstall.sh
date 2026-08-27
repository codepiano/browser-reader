#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$SCRIPT_DIR/stop.sh"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
rm -rf "$PROJECT_ROOT/.control-panel"
echo "Browser Reader 项目运行时产物已清理；dist/ 与依赖未删除。"
