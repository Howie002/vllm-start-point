# Roadmap

Features planned for future development, prioritised roughly by value. Nothing here is scheduled — items get picked up as capacity allows.

---

## Recently Completed

- **Cluster-unified GPU view** — all GPUs from all nodes in one flat grid; node badge per card; click to expand for temperature, power, clock, fan
- **Cluster-unified service list** — all vLLM instances across nodes in one table; expandable rows with context length, quant, tensor parallel, direct endpoint
- **Cross-cluster deployment** — Deploy modal picks GPUs from any node; `targetNode` derived from the selected GPU
- **Child node cluster view** — child dashboards fetch the full node list from the master and show the whole cluster, not just their own GPUs
- **Unified memory GPU support** — DGX Spark GB10 / GB200 unified memory detected automatically; falls back to `torch.cuda.mem_get_info()` / psutil for VRAM reporting; `unified` badge in dashboard
- **Dashboard self-rebuild** — "Restart dashboard" button runs `npm run build` on the agent machine and restarts the server; kills by port as fallback when no PID file
- **Smart allocate (repack)** — bin-packing algorithm reassigns models across GPUs to maximise fit; shows what won't fit; direct button on each stack config row
- **Create stack from scratch** — form-based stack config creation with model picker, GPU assignment, utilisation slider
- **Snapshot running state** — capture currently running instances as a saved stack config
- **Offline node setup command** — when a node is unreachable, the dashboard shows the exact `node.sh setup` command to bring it back online
- **Per-GPU temperature, fan, power, clock** — expanded GPU card shows full telemetry panel

---

## In Progress

### Utilization Logging & Analytics
Track per-model request activity and GPU usage over time so sizing decisions are based on real data rather than guesses.

- [ ] Per-minute sampling: active models, GPU utilisation, VRAM, in-flight requests
- [ ] SQLite store at `logs/utilization.db` — zero external dependencies
- [ ] Hourly and system-level aggregate endpoints on the agent
- [ ] Usage chart in dashboard (GPU util over time, per-model activity breakdown)
- [ ] CSV/JSON export from dashboard
- [ ] Retention policy — auto-prune samples older than N days

---

## Phase 2 — Automation

**Auto-scaling overflow instances**
When a model's queue depth or GPU utilisation crosses a threshold, automatically spin up a second instance on the next free GPU and register it with LiteLLM. Tear it down when load drops.

**Time-based model scheduling**
Define a schedule (e.g. "load the 70B model 08:00–18:00 weekdays, swap to 8B overnight") that the agent enforces automatically at startup and via cron.

**Preload on boot**
Config-driven list of models that should be running at all times. Agent ensures they are present on startup and restarts them if they die.

**Queue depth alerting**
Webhook or email notification when `requests_waiting` is non-zero for more than N seconds — first signal that capacity needs to increase.

---

## Phase 3 — Multi-Node Operations

**Cross-node LiteLLM routing**
Single LiteLLM proxy that load-balances across vLLM instances on *different* machines, not just different GPUs on one box. Today each node has its own proxy.

**Unified request analytics across nodes**
The usage chart currently shows one node at a time. Aggregate across all registered nodes so total cluster load is visible in one view.

**Cross-node model migration**
Move a running model from one GPU/node to another via the dashboard — drain connections, launch on target, deregister source.

---

## Phase 4 — Management & Security

**Dashboard authentication**
Currently the dashboard is open to anyone on the network. Add optional basic-auth or token-based login, configurable in `node_config.json`.

**API key management**
Issue per-application keys through LiteLLM. Track usage per key so you know which app is generating load.

**Per-app usage quotas**
Rate-limit or cap token usage per API key — useful when multiple teams share the cluster.

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
Snapshot the full stack state (running models, GPU assignments, flags) to a JSON file. Restore it on a new machine or after a wipe.

---

## Ideas Backlog

Small or uncertain items that may not be worth building but are worth remembering.

- LM Studio process auto-detection — show actual model name in the GPU process list rather than the raw process label
- Embedding model benchmarking (MTEB subset) — quick retrieval benchmark against a deployed embedding model
- Dark/light theme toggle in dashboard
- Pin a node card to the top of the dashboard
- Export utilization data to Grafana via a Prometheus scrape endpoint on the agent
- Per-node resource reservations — prevent the stack from filling a GPU that's allocated to LM Studio or another tool
- Model family grouping in the deploy modal — show all quantization variants of a base model together
