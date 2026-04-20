# Roadmap

Features planned for future development, prioritised roughly by value. Nothing here is scheduled — items get picked up as capacity allows.

---

## In Progress

### Utilization Logging & Analytics
Track per-model request activity and GPU usage over time so sizing decisions are based on real data rather than guesses.

- [x] Per-minute sampling: active models, GPU utilisation, VRAM, in-flight requests
- [x] SQLite store at `logs/utilization.db` — zero external dependencies
- [x] Hourly and system-level aggregate endpoints on the agent
- [x] Usage chart in dashboard (GPU util over time, per-model activity breakdown)
- [ ] CSV/JSON export from dashboard
- [ ] Retention policy — auto-prune samples older than N days

---

## Phase 2 — Automation

**Auto-scaling overflow instances**
When a model's queue depth or GPU utilisation crosses a threshold, automatically spin up a second instance on the next free GPU and register it with LiteLLM. Tear it down when load drops.

**Time-based model scheduling**
Define a schedule (e.g. "load the 70B model 08:00–18:00 weekdays, swap to 8B overnight") that the agent enforces automatically at startup and via cron.

**Queue depth alerting**
Webhook or email notification when `requests_waiting` is non-zero for more than N seconds — first signal that capacity needs to increase.

**Preload on boot**
Config-driven list of models that should be running at all times. Agent ensures they are present on startup and restarts them if they die.

---

## Phase 3 — Multi-Node Operations

**Cross-node routing in LiteLLM**
Single LiteLLM proxy that load-balances across vLLM instances on *different* machines, not just different GPUs on one box. Today each node has its own proxy.

**Unified request analytics across nodes**
The usage chart currently shows one node at a time. Aggregate across all registered nodes so total cluster load is visible in one view.

**Cross-node model migration**
Move a running model from one GPU/node to another via the dashboard without manual shell work — drain existing connections, launch on target, deregister source.

**Cluster health overview**
Top-level dashboard view: all nodes in a grid, coloured by health status, with a single total VRAM and utilisation number for the whole cluster.

---

## Phase 4 — Management & Security

**Dashboard authentication**
Currently the dashboard is open to anyone on the network. Add optional basic-auth or token-based login, with the token configurable in `node_config.json`.

**API key management**
Issue per-application keys through LiteLLM. Track usage per key so you know which app is generating load.

**Per-app usage quotas**
Rate-limit or cap token usage per API key, useful when multiple teams share the cluster.

**Audit log**
Persistent log of who launched/stopped which model, when, from which IP. Written by the agent on every mutating action.

---

## Phase 5 — Developer Experience

**Request playground in dashboard**
Send a test chat or embedding request directly from the dashboard UI, see the response and latency inline. Removes the need to open a separate tool to verify a newly deployed model is working.

**OpenAPI explorer**
Embed Swagger UI in the dashboard pointing at the LiteLLM proxy, so API consumers can explore available models and endpoints without leaving the browser.

**Model benchmarking**
One-click throughput test: send N concurrent requests to a model, report tokens/second, time-to-first-token, and latency p50/p95. Helps compare quantization options before committing a GPU slot.

**Webhook notifications**
Push events (model healthy, model crashed, GPU OOM, scale-up triggered) to a configurable URL — Slack, Teams, or any webhook receiver.

---

## Phase 6 — Infrastructure

**Docker Compose deployment**
Alternative to the current bare-metal install: a `docker-compose.yml` that containerises the agent, dashboard, and LiteLLM proxy. vLLM itself still runs on the host for GPU passthrough.

**Windows native agent**
Remove the WSL dependency for the agent. The dashboard already runs natively on Windows via Node.js; the Python agent could too with minor changes.

**Automatic model updates**
Check HuggingFace for new revisions of cached models on a schedule. Show "update available" in the model library and allow one-click re-pull.

**Config backup and restore**
Snapshot the full stack state (which models are running, on which GPUs, with what flags) to a JSON file. Restore it on a new machine or after a wipe.

---

## Ideas Backlog

Small or uncertain items that may not be worth building but are worth remembering.

- LM Studio process auto-detection — show LM Studio models in the GPU process list with their actual model name rather than the raw process label
- Embedding model benchmarking (MTEB subset) — run a quick retrieval benchmark against a deployed embedding model
- Dark/light theme toggle in dashboard
- Pin a node card to the top of the dashboard
- Per-GPU temperature and power draw in the GPU card (nvidia-smi already exposes this)
- Export utilization data to Grafana via a Prometheus scrape endpoint on the agent
