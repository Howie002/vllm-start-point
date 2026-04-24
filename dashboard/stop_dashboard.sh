#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$SCRIPT_DIR/.dashboard_pid"

if [ ! -f "$PID_FILE" ]; then
    echo "No PID file found — dashboard may not be running."
else
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
        kill "$PID"
        echo "Stopped dashboard (PID $PID)"
    else
        echo "Process $PID not found (already stopped)"
    fi
    rm -f "$PID_FILE"
fi

PORT="${DASHBOARD_PORT:-3005}"
LEFTOVER=$(lsof -ti:"$PORT" 2>/dev/null)
if [ -n "$LEFTOVER" ]; then
    kill $LEFTOVER 2>/dev/null && echo "Killed leftover process on port $PORT"
fi
