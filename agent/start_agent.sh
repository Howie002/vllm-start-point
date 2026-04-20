#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$HOME/.vllm-venv"
PID_FILE="$SCRIPT_DIR/.agent_pid"
LOG_FILE="$SCRIPT_DIR/agent.log"

if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
        echo "Agent already running (PID $PID). Run stop_agent.sh first."
        exit 1
    fi
    rm -f "$PID_FILE"
fi

if [ ! -f "$VENV_DIR/bin/python" ]; then
    echo "ERROR: venv not found at $VENV_DIR. Run setup.sh first."
    exit 1
fi

# Install agent deps if needed
"$VENV_DIR/bin/pip" install --quiet fastapi uvicorn psutil 2>/dev/null

PORT="${AGENT_PORT:-5000}"
echo "Starting control agent on port $PORT..."
AGENT_PORT="$PORT" "$VENV_DIR/bin/python" "$SCRIPT_DIR/agent.py" > "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
echo "  PID: $(cat "$PID_FILE")"
echo "  Log: $LOG_FILE"

sleep 2
if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    DISPLAY_IP="${AGENT_BIND_IP:-$(hostname -I 2>/dev/null | awk '{print $1}')}"
    echo "Agent running — http://${DISPLAY_IP}:$PORT"
else
    echo "ERROR: Agent failed to start. Check $LOG_FILE"
    rm -f "$PID_FILE"
    exit 1
fi
