#!/bin/bash
# Start the cluster LiteLLM proxy. Runs on master/both nodes; models are
# registered dynamically by each node's agent when vLLM instances launch.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
VENV_DIR="$HOME/.vllm-venv"
PID_FILE="$SCRIPT_DIR/.proxy_pid"
LOG_DIR="$REPO_DIR/logs"
LOG_FILE="$LOG_DIR/litellm.log"
CONFIG_FILE="$SCRIPT_DIR/cluster_config.yaml"
PORT="${LITELLM_PORT:-4000}"

mkdir -p "$LOG_DIR"

if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
        echo "LiteLLM proxy already running (PID $PID). Run stop_proxy.sh first."
        exit 1
    fi
    rm -f "$PID_FILE"
fi

if [ ! -f "$VENV_DIR/bin/litellm" ]; then
    echo "ERROR: litellm binary not found at $VENV_DIR/bin/litellm. Run setup.sh first."
    exit 1
fi

echo "Starting LiteLLM proxy on port $PORT..."
"$VENV_DIR/bin/litellm" --config "$CONFIG_FILE" --port "$PORT" \
    > "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
echo "  PID: $(cat "$PID_FILE")"
echo "  Log: $LOG_FILE"

sleep 4
if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    BIND_IP="${PROXY_BIND_IP:-$(hostname -I 2>/dev/null | awk '{print $1}')}"
    echo "LiteLLM running — http://${BIND_IP}:$PORT"
else
    echo "ERROR: LiteLLM failed to start. Check $LOG_FILE"
    rm -f "$PID_FILE"
    exit 1
fi
