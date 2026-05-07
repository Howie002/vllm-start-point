# AI Distributed Inference Cluster — Notes
*(Renamed from "Foundation AI Infrastructure" / repo `vllm-start-point` on 2026-04-29.)*

## 2026-04-27 — Merged HP Z Workstation Pilot into this project

The standalone "HP Z Workstation Pilot" project was redundant — the Z Workstation work is part of this project's hardware fleet evaluation, not a separate project. Merged the pilot's content into this project's Overview.md as a new "HP Z Workstation Pilot Detail" section, preserving all the original spec / purchase plan / role information.

**Changes:**
- Folder `0. Active Priority/HP Z Workstation Pilot/` deleted (content fully migrated)
- New section in this project's Overview.md captures pilot hardware specs, purchase plan, why this hardware matters, role in v2 cluster, contacts
- "Related Projects" link to the standalone HP Z Workstation Pilot folder removed (folder no longer exists)

Pilot status unchanged: TENTATIVE — awaiting hardware arrival. RTX Pro 6000 Blackwell cards are the candidate. If validated, plan is 2× workstations with 2 cards each.

---

## 2026-04-20 — Model Launch UX Bug Logged

**Issue:** Launching a model from the Deploy modal shows "Launching…" with no feedback for a long time. Observed with `llama-3-3-nemotron-super-49b` (fp8, 50 GB) on Deathstar GPU 2. In one case the model failed silently — user had no way to tell if it was loading, stuck, or dead.

**Logged under:** Roadmap → "Active Issues / UX Gaps" → 🔴 Model launch feedback is opaque

**Why this matters:** Most model launches are multi-minute operations (loading 50GB+ weights into VRAM, initializing KV cache, vLLM warmup). Without stage-level feedback, users cannot distinguish "still working" from "hung" from "failed." This erodes confidence in the cluster.

**Next steps:** Add live log tail + load-stage indicator + explicit failure surface to the Deploy modal. Full acceptance criteria captured in Roadmap.md.

---

## 2026-04-20 — Repo Linked + v2 Cluster Status Catch-up

**Context:** Linked Foundation AI Infrastructure project to the `vllm-start-point` repo. First sync under the new Second Brain ↔ Repo protocol. Previously flagged as "no repo" — corrected. *(Project subsequently renamed to "AI Distributed Inference Cluster" / repo `AI-Distributed-Inference-Cluster` on 2026-04-29.)*

**Since Last SB Update (2026-03-05 → 2026-04-20) — major commits in repo:**
- `3e188e6` Initial commit: full vLLM dashboard with agent control system
- `2946e34` Child node dashboard, create stack UI, smart allocation improvements
- `4907d3c` Cluster GPU view, DGX Spark unified memory fix, smart dashboard restart
- `ec5e06c` Fix aarch64/child-node setup, CUDA detection, and agent IP reporting
- `f00ca8b` Cluster proxy, analytics, model library v2, endpoints tab, rename
- `a8c332c` Fix agent port scan perf, proxy registration, and node setup
- `c9936fd` Fix proxy sync to include child node instances
- `fe13b3b` Self-update system, Settings tab, multi-model testing, dashboard port 3005

**Key Architectural Shift:**
- Original plan: Docker Compose on VM + Nginx round-robin to Ollama on two DGX Sparks
- Current reality: **vLLM Dashboard-managed cluster** with LiteLLM proxy, multi-node agent system, unified GPU view, cross-node deployment
- DGX Spark unified memory (GB10) detection working; aarch64 child nodes supported
- Per-node analytics sampler + DuckDB aggregation shipped

**Sync Changes:**
- SB `Overview.md` — added Repository section; Status updated from "v2 Migration" → "v2 Cluster — Operational Hardening"; architecture rewritten to reflect dashboard-managed cluster
- SB `Project-Instructions.md` — session protocol references updated `To-Do.md` → `Roadmap.md`
- SB `To-Do.md` — deleted (the v2 migration tasks are largely shipped via the dashboard); remaining deployment-level items (DNS, SSL, firewall, snapshots) moved into `Roadmap.md` under "Active Deployment Tasks"
- SB `Roadmap.md` — new file, mirror of `repo/ROADMAP.md` (software roadmap for vLLM dashboard features + deployment tasks)
- Repo `ROADMAP.md` — prepended standardized header (Repo, Last Synced, Current Phase) + new "Active Deployment Tasks" section at top

**Open Deployment Items (carried from old SB To-Do):**
- DNS: `aidev.txamfoundation.com` → cluster master
- SSL via Nginx Proxy Manager / Let's Encrypt
- Firewall lockdown (dashboard / proxy / agent ports)
- VM / node snapshots for DR

---

## VM Setup Status (2026-03-05)

Full status report received. VM is live and healthy.

### Infrastructure — Confirmed Running

| Component | Version | Status |
|-----------|---------|--------|
| VM (App Server) | — | Running |
| Git | v2.43.0 | Installed |
| GitHub CLI (gh) | — | Installed + Authenticated as Howie002 |
| Docker | v29.3.0 | Installed |
| Docker Compose | v5.1.0 | Installed |
| Foundation-Chat Repo | — | Cloned at `/home/aivmadmin/Foundation AI Projects/Foundation Chat` |

### Containers — Confirmed Running

| Container | Port | Status | Notes |
|-----------|------|--------|-------|
| open-webui | :3000 | Healthy | Foundation Secure Chat UI |
| kokoro-tts | :8880 | Running | Text-to-speech, CPU mode |
| searxng | :8888 | Running | Web search |
| redis | :6379 | Running | Session cache |
| nginx-proxy-manager | :80/:81/:443 | Running | SSL + reverse proxy |
| portainer | :9000 | Running | Docker management UI |
| nginx-ollama | :11434 | **Paused** | Waiting on DGX Spark IPs |

### Key Paths
- **Repo location on VM:** `/home/aivmadmin/Foundation AI Projects/Foundation Chat`
- **Nginx Proxy Manager UI:** http://\<vm-ip\>:81
- **Portainer UI:** http://\<vm-ip\>:9000
- **OpenWebUI:** http://\<vm-ip\>:3000
- **Config file to update:** `.env` → `DGX_SPARK_0_IP` and `DGX_SPARK_1_IP`
- **Nginx template:** `configs/nginx-ollama.conf.template` → uncomment DGX Spark 1 entry

### Critical First Actions
1. **Portainer:** Must create admin account within 5 minutes of container start or it locks permanently
2. **OpenWebUI:** First user to register becomes admin — do this before sharing access
3. **Docker permissions:** `sudo usermod -aG docker $USER` has been run — takes effect after full logout/reboot

### What's Working Right Now
OpenWebUI is live and usable immediately upon admin account creation. No AI models connected until DGX Sparks are online. Can temporarily connect to external APIs (OpenAI, Anthropic) via OpenWebUI settings as a bridge if needed.

---

## v2 Architecture Decisions

### Why VM + Dual DGX Spark vs. single node
- Separation of concerns: apps and inference scale independently
- VM snapshots = disaster recovery in minutes
- Round-robin across 2x GB10 nodes = 2x throughput, automatic failover
- AMD Box freed up as dedicated staging/testing environment

### DNS Plan
- **Production:** ai.txamfoundation.com → VM IP (when v2 migration complete)
- **Dev/Staging:** aidev.txamfoundation.com → VM IP (for testing before DNS cutover)
- Nginx Proxy Manager handles SSL termination via Let's Encrypt

### Docker Compose Profile Strategy
- Default profile: all app containers (OpenWebUI, Kokoro, SearXNG, Redis, Nginx PM, Portainer)
- `dgx` profile: nginx-ollama load balancer — only starts when DGX Sparks are online

### Port Security (Action Required)
The following ports should NOT be exposed publicly — firewall rules needed:
- `:8880` — Kokoro TTS
- `:8888` — SearXNG
- `:6379` — Redis
- `:9000` — Portainer

Only `:80` and `:443` (Nginx Proxy Manager) should be public-facing.

---

## Snowflake AI App — Infrastructure Notes

When the Snowflake AI app (Streamlit) is ready to deploy:
- Add as new Docker container on VM alongside existing services
- Assign port (e.g., `:8501`)
- Add proxy host in Nginx Proxy Manager routing to `:8501`
- Connect to Ollama via `nginx-ollama` upstream (:11434) — same as OpenWebUI

---

## DGX Spark 0 (ZGX Nano) — Setup Complete (2026-03-17)

### What Was Built
**`zgx-nano.sh`** — single self-contained management script. Drop on the desktop of any ZGX Nano; a tech can set it up or manage it without knowing the underlying system.

### Setup Completed
| Step | Result |
|------|--------|
| GPU detected | ✅ NVIDIA GB10 |
| Ollama version | ✅ 0.18.1 (already installed) |
| Systemd override | ✅ Ollama listens on `0.0.0.0` (network-accessible) |
| Service enabled | ✅ Starts on boot |
| Default models pulled | ✅ See below |
| API validated | ✅ Responding at `http://10.2.30.32:11434` |

### Models Loaded (~40 GB total, all fit in 128 GB unified memory)
| Model | Size | Purpose |
|-------|------|---------|
| llama3.2:latest | ~2 GB | General chat |
| nemotron-3-nano:30b | 24 GB | NVIDIA agentic model |
| gpt-oss:20b | 14 GB | OpenAI open-weight model |
| nomic-embed-text:latest | ~274 MB | RAG embeddings |

### Script Menu Capabilities
- **Option 1/2** — Start / Restart Ollama service
- **Option 3** — Pull a model (accepts raw name or `ollama pull/run` prefix — strips automatically)
- **Option 4** — Update Ollama binary in place (does not touch models)
- **Option 5** — Status: GPU temp/util, IP, service state, API health, model list
- **Option 6** — Full setup (new node)
- **CLI:** `./zgx-nano.sh pull <modelname>` works without menu

### Current Network Endpoint
```
http://10.2.30.32:11434   ← DHCP — pending static IP from Jose
```

### What's Still Pending
- [ ] **Static IP from Jose's team** — both ZGX Nano IPs currently DHCP; once assigned, set on NIC and update `DGX_SPARK_0_IP=10.2.30.32` in VM `.env`
- [ ] **VM side** — uncomment ZGX Nano entry in `nginx-ollama.conf.template` and restart `nginx-ollama` container
- [ ] **`nginx-ollama.conf.template`** — file does not exist in the repo yet; must be written before VM can route traffic to ZGX Nano
- [ ] **DGX Spark 1** — same process once second unit is ready

## OpenAI-Compatible API Layer — Feature Request (2026-03-17)

**Source:** Ryan Gardner conversation (Investments)
**Request:** Expose Foundation Chat's Ollama endpoint with an OpenAI-compatible API so tools like Claude Code and Codex can point to it via env var overrides:
```
export ANTHROPIC_BASE_URL="http://<foundation-ai-ip>/v1"
export ANTHROPIC_AUTH_TOKEN="foundation"
```

**Use Case:** Investment team members run Claude Code locally and route LLM calls to Foundation's inference nodes instead of paying frontier API costs. Enables multi-agent/subagent workflows on large document sets (data rooms, 100+ docs).

**Ollama already supports this** — Ollama exposes an OpenAI-compatible REST API at `/v1` natively. The work is exposing it safely through the Nginx layer and managing auth tokens per user.

**Blocker:** AI infrastructure is network-segmented from the rest of Foundation. Investment team members on the main network can't reach the AI nodes without a controlled bridge. Need to design a secure path — options:
- VPN tunnel to AI segment for approved users
- Nginx reverse proxy on the main network DMZ forwarding to AI segment
- Per-user token auth on the Ollama/Nginx layer

**Action:** Add to Phase 4 roadmap — design the access architecture before building.

---

### Context Packet for AI Code Editor (send first thing 3/18)

Paste the following into the AI code editor on the project machine to build the `nginx-ollama.conf.template`:

---

**Task:** Write `nginx-ollama.conf.template` for the Foundation Chat repo.

**What it does:** This file is the Nginx upstream config that load-balances LLM inference requests across the DGX Spark nodes. It is templated so environment variables can be substituted at container startup.

**Architecture:**
- The VM runs a Docker container called `nginx-ollama` that proxies all Ollama API traffic on port `:11434`
- Upstream nodes are DGX Spark units running Ollama, each listening on port `11434`
- Round-robin load balancing across available nodes
- Only DGX Spark 0 is active now; DGX Spark 1 entry should be present but commented out until ready

**Environment variables to template:**
- `DGX_SPARK_0_IP` — IP of DGX Spark 0 (currently `10.2.30.32`, pending static assignment)
- `DGX_SPARK_1_IP` — IP of DGX Spark 1 (not yet assigned)

**Where the file lives:** `configs/nginx-ollama.conf.template` in the Foundation Chat repo

**Docker Compose context:** The `nginx-ollama` service uses this template to generate the live Nginx config at container startup. The `dgx` Docker Compose profile controls whether this container runs — it only starts when DGX Sparks are online.

**What to produce:**
1. `configs/nginx-ollama.conf.template` — the Nginx config with `${DGX_SPARK_0_IP}` and `${DGX_SPARK_1_IP}` placeholders
2. Any startup script or Docker entrypoint logic needed to substitute the env vars and launch Nginx (if not already handled in the repo)

**Repo location on VM:** `/home/aivmadmin/Foundation AI Projects/Foundation Chat`

---

## 2026-04-14 — Background Research: Four-Card Workstation AI Setup (NOT the chosen architecture)

> **Status:** Background research only. This was an earlier exploration of a single-machine four-GPU stack. The final Foundation direction is the VM + dual DGX Spark + ZGX Nano topology documented above. Retained here for reference on vLLM/LiteLLM patterns, FP8 deployment, and co-located model tricks that may inform future decisions.

### Summary

Self-hosted AI inference stack across **4× NVIDIA RTX PRO 6000 Blackwell GPUs** (96 GB VRAM each, 384 GB total) serving models via an OpenAI-compatible API through a **LiteLLM proxy** on port 4000. Ubuntu 24.04, NVIDIA driver 580.126.09, CUDA toolkit 12.8, Python 3.12, vLLM 0.19.0, PyTorch 2.10.0+cu128.

### GPU Allocation

| GPU | Role |
|---|---|
| 0 | Dynamic / reserved — LM Studio, overflow, ad-hoc vLLM, model eval |
| 1 | Static co-located: Nemotron Nano FP8 (:8001) + GTE-Qwen2-7B embedding (:8011) |
| 2 | Nemotron Super 49B FP8 Instance A (:8003) |
| 3 | Nemotron Super 49B FP8 Instance B (:8004) — data-parallel pair with GPU 2 |

### Models

- **Nemotron Nano** — `nvidia/Llama-3.1-Nemotron-Nano-8B-v1`, FP8 runtime quant, 32k ctx, fast general reasoning
- **Nemotron Super** — `nvidia/Llama-3_3-Nemotron-Super-49B-v1-FP8` (underscore in ID, not `3.1`), ~50GB weights, FP8 pre-quantized, LiteLLM `least-busy` balances the two GPU instances
- **GTE-Qwen2-7B** — `Alibaba-NLP/gte-Qwen2-7B-instruct`, MTEB 70.24, co-located on GPU 1, used via `--runner pooling`

### Traffic Flow

Single LiteLLM proxy at `:4000/v1` routes OpenAI-style calls by `model` name → appropriate vLLM backend. Direct endpoints also exposed per instance. Health checks at `/health` on each port.

### Bring-up Gotchas Worth Remembering

- **CUDA toolkit 12.8 required at runtime** — vLLM calls `nvcc` during GPU memory profiling and flashinfer FP8 JIT; driver alone is insufficient
- **vLLM 0.19.0 flag changes:** `--disable-log-requests` → `--disable-uvicorn-access-log`; `--task embedding` → `--runner pooling`
- **Venv must live in a space-free path** (e.g., `~/.vllm-venv`) — flashinfer JIT passes include paths to nvcc unquoted, spaces break the compile
- **NV-Embed-v2 unsupported in vLLM 0.19.0** (NVEmbedModel arch missing) — GTE-Qwen2-7B is a better-scoring drop-in
- **`--trust-remote-code`** required for both GTE-Qwen2-7B and Nemotron Super
- **GTE-Qwen2-7B** needs `--hf-overrides '{"is_causal": false}'` to enable bidirectional attention for embeddings
- Overflow Nano can be registered with LiteLLM live via `POST /model/new` — no proxy restart

### Startup

Windows `start.bat` opens `nvidia-smi` monitor + WSL → `setup.sh` (idempotent) → launches 4 vLLM instances → polls health → starts LiteLLM once all healthy. Cold start 5–10 min (first-run downloads ~70 GB), warm start 2–4 min. Logs per service in `./logs/`.

### Why Not Chosen for Foundation

[Fill in when you have a moment — likely: single-machine failure domain, rack/power/cooling footprint, doesn't match the VM + DGX Spark horizontal-scale strategy, ZGX Nano handles the edge/inference role more cleanly]

---

**Last Updated:** 2026-04-14
