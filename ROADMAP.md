# Foundation AI Infrastructure — Roadmap

**Repo:** [github.com/Howie002/vllm-start-point](https://github.com/Howie002/vllm-start-point) (private, active on `dev`)
**Last Synced:** 2026-04-20
**Current Phase:** v2 Cluster — operational hardening + analytics follow-on
**Target Production:** Ongoing operational service

Living document. Software feature work in "In Progress" and phased sections below. Deployment/ops-level tasks in the first section. Nothing is scheduled — items get picked up as capacity allows.

---

## Active Deployment Tasks

Operational tasks layered on top of the running cluster. Not code features — hardware, DNS, security.

### Needs DNS / Network Access
- [ ] Configure `aidev.txamfoundation.com` — point DNS to cluster master
- [ ] Set up proxy host in Nginx Proxy Manager (:81) → dashboard with SSL / Let's Encrypt
- [ ] Lock down port exposure via firewall — dashboard, proxy, agent ports should not be publicly routable

### Production Hardening
- [ ] Schedule regular VM / node snapshots for disaster recovery
- [ ] GPU monitoring — connect analytics JSONL to a persistent dashboard (Grafana or similar)
- [ ] Migrate SQLite → PostgreSQL when user volume grows (if applicable to dashboard state)

### Z Workstation Pilot (Parallel Project)
*See separate `HP Z Workstation Pilot` project — infrastructure listed here for cross-reference.*
- [ ] Confirm pilot loaner delivery date and specs with HP
- [ ] Onboard hardware — OS, NVIDIA drivers, CUDA, vLLM agent
- [ ] Benchmark vs. DGX Sparks using the dashboard
- [ ] Connect to Foundation Snowflake AI app as inference target
- [ ] Purchase decision: 2× workstations, 2 cards each if validated

---

## Active Issues / UX Gaps

### 🔴 Model launch feedback is opaque — "Launching…" with no progress or failure signal

**Priority:** High — blocks confident operation of the cluster
**Reported:** 2026-04-20
**Repro:** Launch `llama-3-3-nemotron-super-49b` (fp8, 50 GB weights) on The Deathstar GPU 2 via the Deploy modal (80% memory, 32768 max context, 256 parallel slots). Modal sits on "Launching…" for a long time with no indication of what is happening. In at least one case the load silently failed and the user had no idea whether the model was still loading, stuck, or dead.

**What's missing**
- No visible stages during model load (spawning → loading weights → warming up → ready)
- No live log tail from the vLLM subprocess in the launch modal
- No progress indicator tied to load phase (weights into VRAM, KV cache init, server ready)
- Silent failures — if vLLM crashes during startup, the dashboard does not surface the error or stderr
- No timeout / "still working…" indicator when a launch is taking longer than expected
- No cancel button once a launch has started

**Acceptance criteria**
- [ ] Launch modal shows live status: `Spawning process` → `Loading config` → `Allocating GPU memory` → `Loading weights (X%)` → `Warming up` → `Ready`
- [ ] Live tail of vLLM stdout/stderr (last ~20 lines) in the launch modal while launching
- [ ] Failure state surfaces the error with a stderr snippet and a "View full log" link
- [ ] Cancel button available throughout launch; kills the spawned process and cleans up GPU allocation
- [ ] If no stdout is observed for >30 s, UI shows `No activity for 30s — last stage: X` so user knows it is not frozen
- [ ] After launch completes, modal auto-dismisses on success and persists on failure

---

## Recently Completed

- **Model Library v2 — per-node download & disk management** — every library row now shows per-node cache status with on-disk size, Download/Delete buttons, and live pre-pull progress bars polled from `/models/hf/downloads`. Top strip shows per-node disk headroom with a warning above 85% usage
- **HuggingFace token management** — per-node token set/clear from the dashboard; tokens are written to `~/.cache/huggingface/token` on the actual node and masked in the UI
- **HF link-based importer** — paste a HuggingFace URL or `org/repo`; agent's `/models/hf/lookup` hits the HF API and prefills params, VRAM estimate, quant guess, context length, type, and license; user reviews before saving to the library
- **Kill silent HF gating** — `/models/hf/preflight` + `auth_check` integration in `/instances/launch` now blocks gated-and-unauthorized deploys with a readable 403 error instead of letting vLLM fail silently in its own log
- **Analytics tab** — per-node 1-minute sampler writes append-only JSONL; DuckDB aggregates to any resolution at query time; 30-day retention with daily file rotation; dashboard charts GPU utilization, requests/bucket (stacked by model), prompt+generation tokens, TTFT p95, plus cluster totals and queue-depth peak
- **Cluster-wide LiteLLM proxy** — single proxy on master serves every node's vLLM instances under one URL; agents register models dynamically using their real node IP; per-node proxy config retired; node.sh lifecycle starts/stops the proxy on master/both roles
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

### Analytics — follow-on work
The v1 analytics tab ships with per-node 1-minute sampling, DuckDB aggregation, and a fixed set of charts. Remaining items to close out the full feature:

- [ ] CSV/JSON export from the Analytics tab (download current window)
- [ ] Co-residency timeline band — render the `coresident_pct` metric as a colored strip under each GPU's utilization line so "when did two models share this GPU?" is instantly visible
- [ ] Error rate panel — parse LiteLLM `/metrics` for 4xx/5xx per model; show only when non-zero
- [ ] Per-model zoom: click a model in the legend → drill-down view with requests, tokens, TTFT, queue depth aligned
- [ ] Backfill tolerance — gracefully handle clock skew across nodes when combining buckets (currently assumes nodes agree on minute boundaries)

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

**Unified request analytics across nodes**
The usage chart currently shows one node at a time. Aggregate across all registered nodes so total cluster load is visible in one view.

**Cross-node model migration**
Move a running model from one GPU/node to another via the dashboard — drain connections, launch on target, deregister source.

**Dynamic cluster partitioning (dual-master sandbox)**
Split the node pool into two (or more) independent clusters from the same physical hardware — a production partition and a staging/testing/batch partition. Each partition has its own master (dashboard + LiteLLM proxy), its own model library authority, its own analytics JSONL, and its own set of assigned nodes; traffic and deploys are isolated between them. Mechanism: add a `partition` field to `node_config.json` and to each node entry in `nodes[]`; the master that serves a partition only shows/manages nodes whose partition matches. A "Fork partition" action in the dashboard picks which of the current nodes come along to the new partition, promotes one as its master, re-registers its agents to point at the new master's proxy, and leaves the production master untouched. Nodes can move between partitions via the dashboard without a service restart — just a config push + proxy re-registration.

Two driving use cases:
1. **Testing** — try new vLLM versions, new model combos, or a risky node.sh change on a subset of hardware without taking the production cluster offline.
2. **Heavy batch isolation** — when a batch workload (eval sweeps, embedding a large corpus, fine-tuning feedback loops) would otherwise hammer interactive production traffic, peel off a few nodes into a batch partition so the network, GPU queues, and VRAM pressure stay contained. When the batch finishes, merge the nodes back.

**Multi-GPU model sharding — run models larger than a single GPU**
Two tiers of GPU combining, at different stages of readiness:
- *Single-node tensor parallelism (supported today)* — launch with `--tensor-parallel-size N` in the Deploy modal; vLLM splits the model's weight matrices across N GPUs on the same machine via NVLink/PCIe. The Deathstar's 4-GPU configuration can hold up to ~384 GB of model weight today.
- *Cross-node pipeline parallelism (future)* — vLLM supports Ray-backed distributed serving across separate machines. This would allow combining GPUs on Deathstar + Nano 0 for a model that requires more VRAM than any single node holds. Requires standing up a Ray cluster across nodes, wiring the agent's launch flow to pass `--pipeline-parallel-size` and the Ray head address, and coordinating model-weight distribution across the WAN link. High network bandwidth between nodes is critical — NVLink is not available cross-node so tensor parallelism is impractical; pipeline parallelism (each node handles different layers) is the correct topology.

**Zero-downtime rolling restart**
One-click "restart everything cleanly" — bring the cluster back to a known-good state without dropping in-flight inference. Agent/dashboard/proxy restarts individually today already lose any model registrations that weren't persisted, and a full `node.sh stop && start` kills every vLLM worker. Mechanism: for each node in sequence, drain its LiteLLM traffic (set weight → 0), wait for in-flight requests, restart the agent and dashboard, replay registered models from a saved manifest (`.cluster_state.json`), verify health, then restore traffic weight. Proxy restarts go last and use a pre-warmed config so there's no registration gap. End state is a fully-refreshed stack with no observable downtime to clients. Builds on cross-node migration + request analytics (to know when "drained" is actually drained).

---

## Model Library — follow-on work

v1 (per-node download / delete / token / importer / gating precheck) shipped above. Remaining items in this area:

**Library propagation across nodes**
Today, a model added via "+ Import from HF" writes to `model_library.json` on the node whose agent the modal talked to. The dashboard pulls from a single node so it *looks* right, but the entry isn't replicated to other nodes. Either (a) each add writes to every online node's library, or (b) promote the master's library as the authoritative copy and have other nodes read through it. (b) is cleaner but requires new API surface.

**Shared HF cache (NFS/SMB)**
Scalable fix for per-node duplication. Instead of `~/.cache/huggingface/hub/` living on each node's local disk, mount a shared volume. One 50 GB download serves the whole cluster. Requires: an install-time option to configure the cache path, plus some care with concurrent-write locking (`huggingface_hub` already handles this via `.lock` files so may Just Work). Low urgency until the cluster grows past 2-3 nodes or disk cost becomes a concern.

**Resume / parallelize downloads**
Downloads currently run one-at-a-time per model, serially per node. huggingface_hub already does parallel-file fetch internally; what's missing is: visible per-file progress within a download, ability to kick off downloads on every node at once with one click ("pre-warm cluster"), and a visible queue when multiple downloads are requested.

**Download priority / throttling**
A single 50 GB model download can saturate network and disk on a smaller node. Add a bandwidth/concurrency limit per node, configurable in `node_config.json`.

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

**Device-profile setup presets**
Today `node.sh setup` asks generic questions (role, IP, port) and a single aarch64-vs-x86_64 switch picks wheels. Real deployments tend to be a handful of well-known platforms — DGX Spark (GB10), HP Z8 Linux + RTX PRO 6000 Blackwell, Jetson, generic x86_64 + consumer RTX, etc. Add a device-type picker to the setup flow that expands into a preset: correct wheel index (cu130 nightly vs cu128 stable), torch pin, vLLM channel (pre vs stable), default GPU layout in `stack_configs.json`, expected SM/compute-cap warnings, and any platform-specific quirks (unified memory, NVLink topology, MIG). A profile registry (`setup_profiles/*.yaml` or similar) keeps the logic out of the shell script and makes new hardware trivial to onboard — add a profile, pick it at setup.

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

---

## Cross-cutting: In-tool Feedback Widget

- [ ] When the Foundation AI Dashboard ships its in-tool feedback widget, drop the shared component into this tool's UI (vLLM Dashboard surface — for IT operators to give feedback on cluster management UX). Per-tool work = thin embed; the shared widget, API, GitHub Issue routing, and central aggregation view are built once in the Foundation AI Dashboard. **Canonical source of truth (design / architecture / acceptance criteria):** [Foundation AI Dashboard → Phase 7](../Foundation%20AI%20Dashboard/Roadmap.md).

---

**Last Updated:** 2026-04-28
