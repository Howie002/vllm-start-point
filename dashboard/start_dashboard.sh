#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$SCRIPT_DIR/.dashboard_pid"
LOG_FILE="$SCRIPT_DIR/dashboard.log"

if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
        echo "Dashboard already running (PID $PID). Run stop_dashboard.sh first."
        exit 1
    fi
    rm -f "$PID_FILE"
fi

# Detect Node.js
if ! command -v node &>/dev/null; then
    echo "ERROR: node not found. Install Node.js 18+ first:"
    echo "  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
    echo "  sudo apt-get install -y nodejs"
    exit 1
fi

cd "$SCRIPT_DIR"

# Install deps if needed
if [ ! -d "node_modules" ]; then
    echo "Installing npm dependencies..."
    npm install
fi

# Build if .next doesn't exist
if [ ! -d ".next" ]; then
    echo "Building dashboard..."
    npm run build
fi

PORT="${DASHBOARD_PORT:-3000}"
AGENT_URL="${AGENT_URL:-http://localhost:5000}"
echo "Starting dashboard (port $PORT)"

AGENT_URL="$AGENT_URL" npm run start -- -p "$PORT" > "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"

sleep 2
if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
    echo "Dashboard running — http://${LOCAL_IP}:$PORT"
    echo "Log: $LOG_FILE"
else
    echo "ERROR: Dashboard failed to start. Check $LOG_FILE"
    rm -f "$PID_FILE"
    exit 1
fi
