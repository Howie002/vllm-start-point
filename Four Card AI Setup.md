# Four Card AI Setup

## Overview

This machine runs a local, self-hosted AI inference stack across four NVIDIA RTX PRO 6000 Blackwell GPUs (96 GB VRAM each, 384 GB total). All models are served via an OpenAI-compatible API, making them drop-in replacements for cloud-based LLM endpoints with no per-token costs and no data leaving the machine.

---

## Hardware & System

| Resource | Spec |
|---|---|
| GPUs | 4× NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition |
| VRAM per card | 96 GB |
| Total VRAM | 384 GB |
| Interconnect | PCIe Gen 5 (no NVLink) |
| OS | Ubuntu 24.04 |
| NVIDIA Driver | 580.126.09 |
| Driver CUDA Level | 13.0 |
| CUDA Toolkit | 12.8 (installed at `/usr/local/cuda-12.8`) |
| Python | 3.12 |
| vLLM | 0.19.0 |
| PyTorch | 2.10.0+cu128 |

---

## One-Time System Prerequisites

These must be installed manually once before the stack can run. After this, `start.bat` handles everything automatically.

```bash
sudo apt-get install -y curl cuda-toolkit-12-8
```

**Why these are required:**
- `curl` — used by health check scripts
- `cuda-toolkit-12-8` — vLLM 0.19.0 calls `nvcc` at runtime during GPU memory profiling and FP8 kernel JIT compilation via flashinfer. The driver alone is not sufficient.

If `cuda-toolkit-12-8` is not found in apt, add the NVIDIA repo first:

```bash
wget https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2404/x86_64/cuda-keyring_1.1-1_all.deb
sudo dpkg -i cuda-keyring_1.1-1_all.deb
sudo apt-get update
sudo apt-get install -y cuda-toolkit-12-8
```

---

## GPU Allocation

```
┌─────────────────────────────────────────────────────────────────────┐
│  GPU 0  │  96GB  │  DYNAMIC / RESERVED                              │
│         │        │  Hot-swap experiments, LM Studio, overflow,      │
│         │        │  ad-hoc vLLM instances, model evaluation         │
│         │        │  Nothing permanently loaded at startup           │
├─────────────────────────────────────────────────────────────────────┤
│  GPU 1  │  96GB  │  STATIC WORKLOADS (two co-located models)        │
│         │        │  ├── vLLM: Nemotron Nano FP8  (~10GB weights)    │
│         │        │  │         --gpu-memory-utilization 0.60         │
│         │        │  │         ~48GB KV cache headroom               │
│         │        │  │         Port :8001                            │
│         │        │  │                                               │
│         │        │  └── vLLM: GTE-Qwen2-7B       (~14GB weights)    │
│         │        │            --gpu-memory-utilization 0.20         │
│         │        │            ~5GB KV cache headroom                │
│         │        │            Port :8011                            │
│         │        │                                                   │
│         │        │  Reserved headroom: ~20% (~19GB) CUDA/buffers    │
├─────────────────────────────────────────────────────────────────────┤
│  GPU 2  │  96GB  │  NEMOTRON SUPER — Instance A                     │
│         │        │  nvidia/Llama-3_3-Nemotron-Super-49B-v1-FP8      │
│         │        │  ~50GB weights (FP8 pre-quantized)               │
│         │        │  ~32GB KV cache headroom                         │
│         │        │  --gpu-memory-utilization 0.85                   │
│         │        │  Port :8003                                       │
├─────────────────────────────────────────────────────────────────────┤
│  GPU 3  │  96GB  │  NEMOTRON SUPER — Instance B (identical)         │
│         │        │  nvidia/Llama-3_3-Nemotron-Super-49B-v1-FP8      │
│         │        │  ~50GB weights (FP8 pre-quantized)               │
│         │        │  ~32GB KV cache headroom                         │
│         │        │  --gpu-memory-utilization 0.85                   │
│         │        │  Port :8004                                       │
│         │        │                                                   │
│         │        │  Data parallelism — two independent instances    │
│         │        │  LiteLLM least-busy load balances between them   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Traffic Flow

All requests enter through a single LiteLLM proxy. Clients use standard OpenAI-compatible API calls and reference models by name — the proxy routes to the correct backend automatically.

```
                         CLIENTS
                            │
                            │ OpenAI-compatible API requests
                            ▼
               ┌────────────────────────┐
               │   LiteLLM Proxy :4000  │
               │                        │
               │  routing: least-busy   │
               │  retries: 3            │
               │  timeout: 600s         │
               └────────────────────────┘
                    │         │        │
          ┌─────────┘         │        └──────────┐
          │                   │                   │
          ▼                   ▼                   ▼
   model="nemotron-nano"  model="nemotron-super"  model="text-embedding"
          │                   │                   │
          ▼                   ├───────────────┐   │
  ┌──────────────┐   ┌────────┴──────┐ ┌─────┴────────┐  ┌──────────────┐
  │ vLLM :8001   │   │  vLLM :8003   │ │  vLLM :8004  │  │ vLLM :8011   │
  │ GPU 1        │   │  GPU 2        │ │  GPU 3       │  │ GPU 1        │
  │ Nano FP8     │   │  Super FP8    │ │  Super FP8   │  │ GTE-Qwen2-7B │
  └──────────────┘   └───────────────┘ └──────────────┘  └──────────────┘

  ┌──────────────────────────────────────────────────────┐
  │ GPU 0  ← DYNAMIC                                     │
  │                                                      │
  │  LM Studio (interactive/eval)         always running │
  │  Ad-hoc vLLM instances                on demand     │
  │  Overflow Nano replica                if GPU 1 pegs  │
  │  Model testing before promoting       as needed      │
  └──────────────────────────────────────────────────────┘
```

---

## Models

### Nemotron Nano — `nemotron-nano`
- **Model:** `nvidia/Llama-3.1-Nemotron-Nano-8B-v1`
- **GPU:** 1
- **Quantization:** FP8 (runtime, via `--quantization fp8`)
- **Context:** 32,768 tokens
- **GPU memory utilization:** 0.60
- **Use case:** Fast, lightweight chat completions and general-purpose reasoning
- **Direct endpoint:** `http://localhost:8001/v1`

### Nemotron Super — `nemotron-super`
- **Model:** `nvidia/Llama-3_3-Nemotron-Super-49B-v1-FP8`
- **GPUs:** 2 (Instance A, port 8003) and 3 (Instance B, port 8004)
- **Quantization:** FP8 pre-quantized official release (~50 GB per card)
- **Context:** 32,768 tokens
- **GPU memory utilization:** 0.85 per card
- **Strategy:** Data parallelism — one full model per GPU, LiteLLM `least-busy` routes between them, effectively doubling throughput
- **Use case:** High-quality reasoning, complex tasks, long-form generation
- **Direct endpoints:** `http://localhost:8003/v1` and `http://localhost:8004/v1`
- **Notes:**
  - Model ID uses underscore: `Llama-3_3` (not `3.1`)
  - Publicly available — no HuggingFace authentication required
  - Requires `--trust-remote-code` flag
  - FP8 JIT kernel compilation via flashinfer requires CUDA toolkit 12.8 at runtime

### GTE-Qwen2-7B — `text-embedding`
- **Model:** `Alibaba-NLP/gte-Qwen2-7B-instruct`
- **GPU:** 1 (co-located with Nano)
- **MTEB score:** 70.24 — state of the art for a locally-runnable embedding model
- **GPU memory utilization:** 0.20
- **Use case:** Text embeddings for RAG pipelines, semantic search, vector databases
- **Direct endpoint:** `http://localhost:8011/v1`
- **Notes:**
  - Uses `--runner pooling` (not `--task embedding` — flag changed in vLLM 0.19.0)
  - Requires `--trust-remote-code` and `--hf-overrides '{"is_causal": false}'` to enable bidirectional attention
  - Natively supported by vLLM via `Qwen2Model` architecture
  - Selected over `nvidia/NV-Embed-v2` because `NVEmbedModel` architecture is not supported in vLLM 0.19.0

---

## API Access

### Unified proxy (recommended)

```
Base URL:  http://localhost:4000/v1
Auth:      Authorization: Bearer none
```

```bash
# Chat — Nano (fast)
curl http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer none" \
  -H "Content-Type: application/json" \
  -d '{"model": "nemotron-nano", "messages": [{"role": "user", "content": "Hello"}]}'

# Chat — Super (high quality, load balanced across GPU 2 and 3)
curl http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer none" \
  -H "Content-Type: application/json" \
  -d '{"model": "nemotron-super", "messages": [{"role": "user", "content": "Explain tensor parallelism"}]}'

# Embeddings
curl http://localhost:4000/v1/embeddings \
  -H "Authorization: Bearer none" \
  -H "Content-Type: application/json" \
  -d '{"model": "text-embedding", "input": "sample text for embedding"}'

# List all available models
curl http://localhost:4000/v1/models \
  -H "Authorization: Bearer none"
```

### Direct vLLM endpoints

Each instance also exposes a raw OpenAI-compatible endpoint (bypasses the proxy):

| Model | GPU | Port | Base URL |
|---|---|---|---|
| Nemotron Nano | 1 | 8001 | `http://localhost:8001/v1` |
| GTE-Qwen2-7B (embed) | 1 | 8011 | `http://localhost:8011/v1` |
| Nemotron Super A | 2 | 8003 | `http://localhost:8003/v1` |
| Nemotron Super B | 3 | 8004 | `http://localhost:8004/v1` |
| LiteLLM proxy | — | 4000 | `http://localhost:4000/v1` |

### Health checks

```bash
curl http://localhost:8001/health   # Nano
curl http://localhost:8011/health   # Embed
curl http://localhost:8003/health   # Super A
curl http://localhost:8004/health   # Super B
```

---

## Starting and Stopping

### From Windows (primary method)

Double-click `start.bat` to:
1. Open a live GPU monitor window (`nvidia-smi` refreshing every 2 seconds)
2. Run setup — creates/updates the Python venv and installs all packages
3. Launch the full inference stack

Double-click `stop.bat` to shut everything down cleanly.

### From Linux

```bash
./start_inference_stack.sh   # Start
./stop_inference_stack.sh    # Stop
```

### Startup sequence

1. `setup.sh` runs — checks Python, GPU, CUDA toolkit, creates `~/.vllm-venv` if needed, installs/updates all pip packages
2. Nemotron Nano launches on GPU 1 (background)
3. GTE-Qwen2-7B launches on GPU 1 alongside Nano (background)
4. Nemotron Super A launches on GPU 2 (background)
5. Nemotron Super B launches on GPU 3 (background)
6. Health endpoints polled every 10 seconds — waits up to 10 minutes for all four to become healthy
7. LiteLLM proxy starts once all vLLM instances are healthy

**First-run cold start:** 5–10 minutes (model downloads ~70 GB total + JIT kernel compilation)
**Subsequent starts:** 2–4 minutes (weights already cached, kernels already compiled)

Logs for each service are written to `./logs/`:

| Log file | Service |
|---|---|
| `logs/nemotron-nano.log` | Nemotron Nano |
| `logs/nv-embed.log` | GTE-Qwen2-7B embedding |
| `logs/nemotron-super-a.log` | Super Instance A (GPU 2) |
| `logs/nemotron-super-b.log` | Super Instance B (GPU 3) |
| `logs/litellm.log` | LiteLLM proxy |

---

## GPU 0 — Dynamic Use

GPU 0 is intentionally left unallocated at startup. Common uses:

- **LM Studio** — interactive model evaluation, always available on its default port `:1234`
- **Overflow Nano replica** — if GPU 1 becomes saturated under load, spin up a second Nano instance on GPU 0 and register it with LiteLLM live (no restart needed)
- **Ad-hoc model testing** — load any model temporarily for evaluation before promoting it to a static slot

### Spin up an overflow Nano on GPU 0

```bash
# Launch
CUDA_VISIBLE_DEVICES=0 ~/.vllm-venv/bin/vllm serve nvidia/Llama-3.1-Nemotron-Nano-8B-v1 \
  --port 8002 \
  --quantization fp8 \
  --gpu-memory-utilization 0.60 \
  --served-model-name nemotron-nano \
  --disable-uvicorn-access-log &

# Register with LiteLLM at runtime (no proxy restart)
curl -X POST http://localhost:4000/model/new \
  -H "Authorization: Bearer none" \
  -H "Content-Type: application/json" \
  -d '{
    "model_name": "nemotron-nano",
    "litellm_params": {
      "model": "openai/nemotron-nano",
      "api_base": "http://localhost:8002/v1",
      "api_key": "none"
    }
  }'
```

LiteLLM will automatically load-balance across both Nano instances using `least-busy`.

---

## Implementation Notes

These are things discovered during the actual bring-up that are not obvious from documentation.

### vLLM 0.19.0 CLI changes
The following flags changed from earlier vLLM versions:

| Old flag | New flag in 0.19.0 |
|---|---|
| `--disable-log-requests` | `--disable-uvicorn-access-log` |
| `--task embedding` | `--runner pooling` |

### CUDA toolkit is required at runtime
vLLM 0.19.0 calls `nvcc` during GPU memory profiling (`determine_available_memory`) and again during flashinfer FP8 kernel JIT compilation. Installing only the NVIDIA driver is not sufficient — `cuda-toolkit-12-8` must be present and on `PATH`.

### Venv must be in a space-free path
The flashinfer JIT compiler passes include paths directly to `nvcc`. If those paths contain spaces (e.g. from the project directory `Github Projects/Vllm Start Point`), nvcc interprets words after the space as separate arguments and fails. The venv lives at `~/.vllm-venv` to avoid this.

### NV-Embed-v2 is not supported in vLLM 0.19.0
`nvidia/NV-Embed-v2` uses the `NVEmbedModel` architecture which is not in vLLM 0.19.0's supported architecture list. Replaced with `Alibaba-NLP/gte-Qwen2-7B-instruct` which scores higher on MTEB (70.24) and is natively supported.

### Nemotron Super model ID
The correct model is `nvidia/Llama-3_3-Nemotron-Super-49B-v1-FP8` — note `3_3` with underscores, not `3.1`. The model is publicly available with no HuggingFace authentication required.

### trust-remote-code required
Both GTE-Qwen2-7B and Nemotron Super require `--trust-remote-code`. Without it, vLLM refuses to load due to custom code in the model repository.

### GTE-Qwen2-7B requires is_causal override
The model uses bidirectional attention for embeddings, but its HuggingFace config declares it as causal. Must pass `--hf-overrides '{"is_causal": false}'` or the model produces incorrect embeddings.

---

## Files

| File | Purpose |
|---|---|
| `requirements.txt` | Pinned Python package versions — single source of truth for deps |
| `setup.sh` | Idempotent install script — runs on every start, fast if already set up |
| `start_inference_stack.sh` | Launches all 5 services, polls health, writes PIDs to `.stack_pids` |
| `stop_inference_stack.sh` | Graceful shutdown via PIDs, force-kills anything on known ports |
| `start.bat` | Windows entry point — GPU monitor window + WSL stack launch |
| `stop.bat` | Windows stop — calls stop script via WSL |
| `litellm_config.yaml` | LiteLLM proxy config — model routing, retries, timeouts |
| `logs/` | Per-service log files, created at runtime |
| `.stack_pids` | Runtime PID file, created/deleted automatically by start/stop scripts |
| `.gitignore` | Excludes logs, PIDs, venv references |

**Note:** The Python venv is stored at `~/.vllm-venv` (outside the repo) to avoid spaces-in-path issues with nvcc. It is not committed.
