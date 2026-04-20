#!/bin/bash
set -e

# Ensure CUDA toolkit binaries are in PATH
for CUDA_BIN in /usr/local/cuda/bin /usr/local/cuda-12.8/bin /usr/local/cuda-12/bin; do
    [ -d "$CUDA_BIN" ] && export PATH="$CUDA_BIN:$PATH"
done

# Ensure venv binaries (ninja, etc.) are in PATH for subprocess calls by vLLM/flashinfer
[ -d "$HOME/.vllm-venv/bin" ] && export PATH="$HOME/.vllm-venv/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$HOME/.vllm-venv"          # Must match setup.sh — space-free path for nvcc
PID_FILE="$SCRIPT_DIR/.stack_pids"
LOG_DIR="$SCRIPT_DIR/logs"

# ── Run setup (creates venv, installs / updates deps) ────────────────────────

echo "=== Checking / installing dependencies ==="
bash "$SCRIPT_DIR/setup.sh"
if [ $? -ne 0 ]; then
    echo "ERROR: setup.sh failed. Fix the errors above before starting the stack."
    exit 1
fi

# Use binaries from the venv exclusively
VLLM="$VENV_DIR/bin/vllm"
LITELLM="$VENV_DIR/bin/litellm"

# ── Sanity checks ────────────────────────────────────────────────────────────

if [ -f "$PID_FILE" ]; then
    echo "ERROR: PID file exists at $PID_FILE — stack may already be running."
    echo "       Run stop_inference_stack.sh first, or delete the PID file manually."
    exit 1
fi

if [ ! -f "$SCRIPT_DIR/litellm_config.yaml" ]; then
    echo "ERROR: litellm_config.yaml not found in $SCRIPT_DIR"
    exit 1
fi

mkdir -p "$LOG_DIR"

echo ""
echo "=== Starting vLLM Inference Stack ==="
echo "Logs → $LOG_DIR"
echo ""

# ── GPU 1 — Nemotron Nano ────────────────────────────────────────────────────

echo "[1/4] Starting Nemotron Nano on GPU 1 (port 8001)..."
CUDA_VISIBLE_DEVICES=1 "$VLLM" serve nvidia/Llama-3.1-Nemotron-Nano-8B-v1 \
    --port 8001 \
    --quantization fp8 \
    --gpu-memory-utilization 0.60 \
    --max-model-len 32768 \
    --served-model-name nemotron-nano \
    --disable-uvicorn-access-log \
    > "$LOG_DIR/nemotron-nano.log" 2>&1 &
NANO_PID=$!
echo "  PID: $NANO_PID"

# ── GPU 1 — NV-Embed-v2 (co-located) ────────────────────────────────────────

echo "[2/4] Starting GTE-Qwen2-7B embedding on GPU 1 (port 8011, co-located)..."
# gte-Qwen2-7B-instruct: MTEB 70.24, natively supported by vLLM via Qwen2Model
# --hf-overrides sets is_causal=false to enable bidirectional attention (required for embeddings)
CUDA_VISIBLE_DEVICES=1 "$VLLM" serve Alibaba-NLP/gte-Qwen2-7B-instruct \
    --port 8011 \
    --runner pooling \
    --trust-remote-code \
    --hf-overrides '{"is_causal": false}' \
    --gpu-memory-utilization 0.20 \
    --served-model-name text-embedding \
    --disable-uvicorn-access-log \
    > "$LOG_DIR/nv-embed.log" 2>&1 &
EMBED_PID=$!
echo "  PID: $EMBED_PID"

# ── GPU 2+3 — Nemotron Super (TP=2) ─────────────────────────────────────────

echo "[3/4] Starting Nemotron Super on GPU 2 (port 8003, instance A)..."
# Two independent instances (data parallelism) — one per card, TP=1
# FP8 pre-quantized ~50GB fits on 96GB card with room for KV cache
# TP=1 avoids inter-GPU kernel compilation (no nvcc needed)
CUDA_VISIBLE_DEVICES=2 "$VLLM" serve nvidia/Llama-3_3-Nemotron-Super-49B-v1-FP8 \
    --port 8003 \
    --trust-remote-code \
    --gpu-memory-utilization 0.85 \
    --max-model-len 32768 \
    --served-model-name nemotron-super \
    --disable-uvicorn-access-log \
    > "$LOG_DIR/nemotron-super-a.log" 2>&1 &
SUPER_A_PID=$!
echo "  PID: $SUPER_A_PID"

echo "[3b/4] Starting Nemotron Super on GPU 3 (port 8004, instance B)..."
CUDA_VISIBLE_DEVICES=3 "$VLLM" serve nvidia/Llama-3_3-Nemotron-Super-49B-v1-FP8 \
    --port 8004 \
    --trust-remote-code \
    --gpu-memory-utilization 0.85 \
    --max-model-len 32768 \
    --served-model-name nemotron-super \
    --disable-uvicorn-access-log \
    > "$LOG_DIR/nemotron-super-b.log" 2>&1 &
SUPER_B_PID=$!
echo "  PID: $SUPER_B_PID"

# ── Persist PIDs ─────────────────────────────────────────────────────────────

cat > "$PID_FILE" <<EOF
NANO_PID=$NANO_PID
EMBED_PID=$EMBED_PID
SUPER_A_PID=$SUPER_A_PID
SUPER_B_PID=$SUPER_B_PID
EOF

# ── Wait for models to load ───────────────────────────────────────────────────

echo ""
echo "[4/4] Waiting for models to load — this typically takes 2-5 minutes..."
echo ""

WAIT_SECS=600
POLL=10
ELAPSED=0

while [ $ELAPSED -lt $WAIT_SECS ]; do
    sleep $POLL
    ELAPSED=$((ELAPSED + POLL))

    NANO_UP=0; EMBED_UP=0; SUPER_A_UP=0; SUPER_B_UP=0
    wget -q --spider http://localhost:8001/health 2>/dev/null && NANO_UP=1
    wget -q --spider http://localhost:8011/health 2>/dev/null && EMBED_UP=1
    wget -q --spider http://localhost:8003/health 2>/dev/null && SUPER_A_UP=1
    wget -q --spider http://localhost:8004/health 2>/dev/null && SUPER_B_UP=1

    printf "  [%3ds] nano:%s  embed:%s  super-a:%s  super-b:%s\n" \
        "$ELAPSED" \
        "$([ $NANO_UP -eq 1 ]     && echo 'UP  ' || echo 'wait')" \
        "$([ $EMBED_UP -eq 1 ]    && echo 'UP  ' || echo 'wait')" \
        "$([ $SUPER_A_UP -eq 1 ]  && echo 'UP  ' || echo 'wait')" \
        "$([ $SUPER_B_UP -eq 1 ]  && echo 'UP  ' || echo 'wait')"

    if [ $NANO_UP -eq 1 ] && [ $EMBED_UP -eq 1 ] && [ $SUPER_A_UP -eq 1 ] && [ $SUPER_B_UP -eq 1 ]; then
        echo ""
        echo "  All three vLLM instances healthy — starting LiteLLM proxy..."
        break
    fi
done

if [ $ELAPSED -ge $WAIT_SECS ]; then
    echo ""
    echo "WARNING: Timed out waiting for health checks. Starting LiteLLM anyway."
    echo "         Check logs in $LOG_DIR if requests fail."
fi

# ── LiteLLM Proxy ────────────────────────────────────────────────────────────

echo ""
echo "Starting LiteLLM proxy (port 4000)..."
"$LITELLM" --config "$SCRIPT_DIR/litellm_config.yaml" --port 4000 \
    > "$LOG_DIR/litellm.log" 2>&1 &
LITELLM_PID=$!
echo "  PID: $LITELLM_PID"

echo "LITELLM_PID=$LITELLM_PID" >> "$PID_FILE"

sleep 5

echo ""
echo "╔════════════════════════════════════════════════════╗"
echo "║           Inference Stack Ready                    ║"
echo "╠════════════════════════════════════════════════════╣"
echo "║  LiteLLM proxy:    http://localhost:4000           ║"
echo "║  Nano  (direct):   http://localhost:8001  GPU 1    ║"
echo "║  Embed (direct):   http://localhost:8011  GPU 1    ║"
echo "║  Super-A (direct): http://localhost:8003  GPU 2    ║"
echo "║  Super-B (direct): http://localhost:8004  GPU 3    ║"
echo "║                                                    ║"
echo "║  GPU 0:  AVAILABLE for dynamic use                 ║"
echo "║  Logs:   ./logs/                                   ║"
echo "╚════════════════════════════════════════════════════╝"
echo ""
echo "To stop the stack:  ./stop_inference_stack.sh"
echo ""
echo "Quick health check:"
echo "  wget -qO- http://localhost:8001/health"
echo "  wget -qO- http://localhost:8003/health"
echo "  wget -qO- http://localhost:8004/health"
echo "  wget -qO- http://localhost:8011/health"
echo "  wget -qO- --header='Authorization: Bearer none' http://localhost:4000/v1/models"
