# vLLM Stack

Self-hosted AI inference across one or more GPU machines. All models served through an OpenAI-compatible API — drop-in replacement for cloud endpoints with no per-token cost and no data leaving the network.

---

## Quick Start

### Single machine (GPU + dashboard on same box)

```bash
git clone <repo>
cd <repo>
./node.sh        # choose role: both
```

The script asks for role, IP, and ports, installs all dependencies, and starts everything.

### Adding a second GPU machine

On the **new machine**:
```bash
./node.sh        # choose role: child
                 # enter master IP when prompted
```

On the **master**, open the dashboard → click **+ Add node** → follow the on-screen instructions. The dashboard generates the exact setup command needed on the child machine.

---

## Node Roles

| Role | What runs | Use when |
|---|---|---|
| `both` | vLLM + agent + dashboard | Single GPU machine |
| `master` | Dashboard only | Dedicated management VM (no GPU) |
| `child` | vLLM + control agent | Additional GPU server |

Child nodes run their own dashboard instance too, showing the full cluster (master + siblings) — not just their own GPUs.

---

## node.sh Commands

```
./node.sh              # Interactive menu (first run = full setup)
./node.sh setup        # Configure role, IPs, install all dependencies
./node.sh start        # Start services for this node's role
./node.sh stop         # Stop all local services
./node.sh add-node     # Register a new child node with this master
./node.sh status       # Check what's running + ping all registered nodes
```

---

## Architecture

```
                         CLIENTS
                            │
                            ▼
               ┌────────────────────────┐
               │   Dashboard  :3005     │  ← any node (master or child)
               └────────────────────────┘
                    │           │
          polls each agent      │ fetches node list from master
                    ▼           ▼
            ┌──────────────────────────────┐
            │  Control Agent  :5000        │  ← each GPU machine
            │  GPU stats, instance mgmt,   │
            │  model library, proxy mgmt   │
            └──────────────────────────────┘
                            │
               ┌────────────┴────────────┐
               ▼                         ▼
   ┌───────────────────┐     ┌───────────────────────┐
   │  LiteLLM  :4000   │     │  vLLM instances       │
   │  Proxy + routing  │────▶│  :8020 :8021 :8022 …  │
   └───────────────────┘     └───────────────────────┘
```

The master agent exposes `GET /nodes` so every node can fetch the full cluster topology. Each node's dashboard shows GPUs and instances from every registered node in one unified view.

---

## Dashboard

Access at `http://<any-node-ip>:3005`

- **GPU Cluster** — all GPUs across all nodes in one flat grid, grouped by node badge per card. Click any card for temperature, power draw, clock, fan speed detail.
- **Running Instances** — unified table of all vLLM instances with node, model, port, GPU, status. Click a row for context length, quantization, tensor parallel, endpoint URL.
- **Node Management** — per-node agent controls (restart, stop) and stack template management.
- **Model Library** — searchable catalog with one-click Deploy to any GPU across the cluster.
- **Stack Templates** — saved GPU assignments with preflight checks and smart repack (bin-packing) to optimise utilisation.

The dashboard can rebuild itself: **Node Management → Restart dashboard** runs `npm run build` on the machine and restarts the server in the background.

---

## API Access

All requests go through the LiteLLM proxy:

```
Base URL:   http://<gpu-machine>:4000/v1
Auth:       Authorization: Bearer none
```

```bash
# Chat
curl http://<gpu-machine>:4000/v1/chat/completions \
  -H "Authorization: Bearer none" \
  -H "Content-Type: application/json" \
  -d '{"model": "nemotron-nano", "messages": [{"role": "user", "content": "Hello"}]}'

# Embeddings
curl http://<gpu-machine>:4000/v1/embeddings \
  -H "Authorization: Bearer none" \
  -H "Content-Type: application/json" \
  -d '{"model": "text-embedding", "input": "sample text"}'
```

The vLLM instances are also directly accessible at `http://<gpu-machine>:<port>/v1` — useful for bypassing the proxy during testing.

---

## Special Hardware

### NVIDIA DGX Spark (GB10 Grace Blackwell)

The DGX Spark uses a unified 128 GB LPDDR5x memory pool shared between the CPU and GPU. `nvidia-smi` returns `Not Supported` for memory fields. The agent detects this automatically:

- Falls back to `torch.cuda.mem_get_info()` for accurate GPU memory reporting
- GPU cards in the dashboard show a **unified** badge and label the VRAM bar as `(RAM)`
- The Deploy modal shows a note that VRAM figures represent shared system RAM

vLLM on the DGX Spark requires `--enforce-eager` due to SM121 not being fully supported by compiled CUDA kernels. Set this in the model's `extra_flags` in the library.

---

## Dependencies

**System prerequisites** (installed automatically by `node.sh setup`):
```bash
sudo apt-get install -y curl cuda-toolkit-12-8
```

**Python venv** is created at `~/.vllm-venv` (outside the repo to avoid spaces-in-path issues with nvcc).

**Node.js 20+** is required on nodes that run the dashboard. `node.sh setup` installs it automatically via NodeSource if missing.

---

## Files

| File | Purpose |
|---|---|
| `node.sh` | Unified node manager — configure, install, start, stop, add nodes |
| `setup.sh` | Idempotent Python venv + vLLM installer (called by node.sh) |
| `agent/agent.py` | FastAPI control agent — GPU stats, instance mgmt, model library, stack configs |
| `agent/model_library.json` | Curated model catalog with VRAM, quantization, and flag metadata |
| `agent/start_agent.sh` / `stop_agent.sh` | Agent lifecycle scripts |
| `dashboard/` | Next.js cluster dashboard |
| `dashboard/start_dashboard.sh` / `stop_dashboard.sh` | Dashboard lifecycle scripts |
| `stack_configs.json` | Named stack templates with GPU/port assignments |
| `litellm_config.yaml` | LiteLLM proxy routing and retry config |
| `node_config.json` | Generated by `node.sh setup` — machine-specific, gitignored |
| `logs/` | Per-service log files, created at runtime, gitignored |
| `Four Card AI Setup.md` | Detailed hardware/software reference for the original 4× RTX PRO 6000 setup |

---

## Windows

`start.bat` and `stop.bat` launch the stack via WSL with an nvidia-smi monitor window. They are an alternative to `node.sh` for machines where WSL is the primary interface.

---

## Troubleshooting

**Node shows 0 GPUs / 0 VRAM**
- nvidia-smi may be returning `Not Supported` for memory fields (unified memory hardware like DGX Spark). Update the agent — the fix is in `agent.py` as of the current version.
- Run `nvidia-smi --query-gpu=index,name,memory.total --format=csv` on the machine to check raw output.

**Agent unreachable in dashboard**
- Check firewall: the dashboard needs TCP access to port 5000 on each child node.
- Check the agent is running: `curl http://<node-ip>:5000/health`
- The offline node card shows the exact `node.sh setup` command to re-run.

**Port already in use on start**
- `./node.sh status` shows what's running and on which ports.
- `./node.sh stop` then `./node.sh start` to restart cleanly.

**Dashboard not reflecting code changes**
- The production server serves a pre-built bundle. Use **Restart dashboard** in the UI (triggers rebuild + restart), or run `npm run build && npm start` in `dashboard/` manually.
