#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$SCRIPT_DIR/.proxy_pid"
PORT="${LITELLM_PORT:-4000}"

if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
        kill "$PID" 2>/dev/null || true
        sleep 1
        kill -0 "$PID" 2>/dev/null && kill -9 "$PID" 2>/dev/null || true
        echo "Stopped LiteLLM proxy (PID $PID)"
    else
        echo "Process $PID not found (already stopped)"
    fi
    rm -f "$PID_FILE"
else
    # Fall back to scanning by port, in case the pid file was lost.
    STALE=$(lsof -ti ":$PORT" 2>/dev/null | head -1)
    if [ -n "$STALE" ]; then
        kill "$STALE" 2>/dev/null && echo "Killed stray LiteLLM on port $PORT (PID $STALE)" || true
    else
        echo "No PID file found — LiteLLM proxy may not be running."
    fi
fi
