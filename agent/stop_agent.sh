#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$SCRIPT_DIR/.agent_pid"

if [ ! -f "$PID_FILE" ]; then
    echo "No PID file found — agent may not be running."
else
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
        kill "$PID"
        echo "Stopped agent (PID $PID)"
    else
        echo "Process $PID not found (already stopped)"
    fi
    rm -f "$PID_FILE"
fi

# Fallback: kill anything on port 5000
LEFTOVER=$(lsof -ti:5000 2>/dev/null)
if [ -n "$LEFTOVER" ]; then
    kill $LEFTOVER 2>/dev/null && echo "Killed leftover process on port 5000"
fi
