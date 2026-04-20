#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$SCRIPT_DIR/.stack_pids"

echo "=== Stopping vLLM Inference Stack ==="

if [ ! -f "$PID_FILE" ]; then
    echo "WARNING: PID file not found at $PID_FILE"
    echo "         Falling back to process name scan..."

    echo ""
    echo "Killing any vllm serve processes..."
    pkill -f "vllm serve" && echo "  Done." || echo "  None found."

    echo "Killing any litellm processes..."
    pkill -f "litellm" && echo "  Done." || echo "  None found."

    echo ""
    echo "Stack stopped (via process name scan)."
    exit 0
fi

# ── Load PIDs ─────────────────────────────────────────────────────────────────

source "$PID_FILE"

kill_pid() {
    local name=$1
    local pid=$2

    if [ -z "$pid" ]; then
        echo "  $name: no PID recorded, skipping"
        return
    fi

    if kill -0 "$pid" 2>/dev/null; then
        echo "  Stopping $name (PID $pid)..."
        kill "$pid" 2>/dev/null

        # Wait up to 15 seconds for graceful shutdown
        local waited=0
        while kill -0 "$pid" 2>/dev/null && [ $waited -lt 15 ]; do
            sleep 1
            waited=$((waited + 1))
        done

        if kill -0 "$pid" 2>/dev/null; then
            echo "    Grace period expired — sending SIGKILL..."
            kill -9 "$pid" 2>/dev/null
        else
            echo "    Stopped."
        fi
    else
        echo "  $name (PID $pid): already stopped"
    fi
}

# Stop in reverse order: proxy first, then model servers
kill_pid "LiteLLM proxy  " "$LITELLM_PID"
kill_pid "Nemotron Nano  " "$NANO_PID"
kill_pid "Embed (GTE-Q2) " "$EMBED_PID"
kill_pid "Super-A (GPU 2)" "$SUPER_A_PID"
kill_pid "Super-B (GPU 3)" "$SUPER_B_PID"

# ── Cleanup ───────────────────────────────────────────────────────────────────

rm -f "$PID_FILE"
echo ""
echo "PID file removed."

# Brief pause then confirm nothing is lingering on the known ports
sleep 2
echo ""
echo "Port check (should all be empty):"
for port in 8001 8003 8004 8011 4000; do
    pid=$(lsof -ti ":$port" 2>/dev/null)
    if [ -n "$pid" ]; then
        echo "  :$port  still occupied by PID $pid — force-killing..."
        kill -9 $pid 2>/dev/null
    else
        echo "  :$port  clear"
    fi
done

echo ""
echo "=== Stack stopped ==="
