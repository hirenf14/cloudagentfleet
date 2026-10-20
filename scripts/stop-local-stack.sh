#!/usr/bin/env bash
# Stop local Cloud Agent Fleet test/runtime processes (Hub, Worker, Codeman web).
# Usage (from Windows):  wsl.exe -d Ubuntu -- bash /mnt/e/cloud-agent-fleet/scripts/stop-local-stack.sh
#   (pass -d Ubuntu explicitly if the default WSL distro is not Ubuntu)
# Usage (inside WSL/Linux/macOS): bash scripts/stop-local-stack.sh
set -euo pipefail
export PATH="${HOME}/.local/bin:/usr/bin:${PATH}"

echo "Stopping Cloud Agent Fleet local stack..."

pkill -f 'cloudagentfleet-hub.mjs' 2>/dev/null && echo "  stopped hub" || echo "  hub not running"
pkill -f 'cloudagentfleet-worker.mjs' 2>/dev/null && echo "  stopped worker" || echo "  worker not running"

# Test keep-alive helpers (if any)
pkill -f 'tmp-wsl-full-keep.sh' 2>/dev/null || true
pkill -f 'tmp-wsl-worker-keep.sh' 2>/dev/null || true
pkill -f 'tmp-bash-test-stack.sh' 2>/dev/null || true
for pattern in 'sleep 7200' 'sleep 3600'; do
  for pid in $(pgrep -f "$pattern" 2>/dev/null || true); do
    kill "$pid" 2>/dev/null || true
  done
done

if command -v codeman >/dev/null 2>&1; then
  codeman web --stop 2>/dev/null && echo "  stopped Codeman web" || echo "  Codeman web not running"
else
  pkill -f 'codeman web' 2>/dev/null && echo "  stopped Codeman web" || echo "  Codeman web not running"
fi

sleep 1
if ss -tlnp 2>/dev/null | grep -qE ':8787|:3000'; then
  echo "WARNING: ports still listening:"
  ss -tlnp 2>/dev/null | grep -E ':8787|:3000' || true
  exit 1
fi

echo "Stack stopped (8787/3000 clear)."
