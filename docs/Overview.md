# AI Distributed Inference Cluster

## Repository
- **Repo:** [github.com/Howie002/AI-Distributed-Inference-Cluster](https://github.com/Howie002/AI-Distributed-Inference-Cluster) (private)
- **Branches:** `main` stable, `dev` active (currently equal)
- **Docs synced to:** `repo/docs/`
- **Roadmap:** `repo/ROADMAP.md` (mirrors `Roadmap.md` in this folder)
- **Scope:** vLLM dashboard + agent control system — the control plane for the multi-node cluster

## Purpose
Enduring project tracking the build-out, migration, maintenance, and evolution of Foundation's on-premises AI infrastructure. Covers hardware fleet management, v2 architecture migration, vLLM dashboard & agent development, future scaling decisions, and ongoing operational health.

## Status
**Current Phase:** v2 Cluster — Operational Hardening + Analytics Follow-on
**Started:** 2025
**Last Updated:** 2026-04-27

## Current Architecture (v2)

Multi-node GPU cluster managed via the cluster dashboard (`AI-Distributed-Inference-Cluster` repo, formerly `vllm-start-point`). Cluster includes master + child nodes, unified GPU view, LiteLLM proxy for model serving, and per-node analytics. DGX Spark unified memory (GB10) fully supported; cross-node deployment works via dashboard. Previous architecture used Docker Compose on a single VM with Nginx-round-robin to Ollama nodes — that pattern has been superseded by the dashboard-managed cluster.

**Reference:** See [Foundation-AI-Architecture.md](../../Foundation-AI-Architecture.md) for full architecture diagram, network topology, and port map.

## Hardware Fleet

| Device | Model | GPU | Role | Status |
|--------|-------|-----|------|--------|
| VM Host | TBD | N/A | App Server (Docker) | Planned |
| DGX Spark 0 | HP ZGX Nano G1n | NVIDIA GB10, 128GB | Inference Node 0 | ✅ Ollama Running — Pending Static IP + nginx-ollama config |
| DGX Spark 1 | HP ZGX Nano G1n | NVIDIA GB10, 128GB | Inference Node 1 | Setup Pending |
| AMD Box | HP AI Box | AMD 395+, 128GB | Testing / Staging | Available |
| Z Workstation | HP Z Workstation (Pilot) | 4x RTX Pro 6000 Blackwell | Pilot — Snowflake AI | TENTATIVE |

## Infrastructure Phases

### Phase 1 — v2 Migration (Active)
Complete the migration from AMD Box single-node to VM + dual DGX Spark architecture. Establish snapshot/DR capability, round-robin inference, and staging pipeline.

### Phase 2 — Z Workstation Pilot (Parallel)
Evaluate HP Z Workstation (4x RTX Pro 6000 Blackwell) for high-capacity inference. Purchase decision: 2x workstations with 2 cards each if validated. See HP Z Workstation Pilot project.

### Phase 3 — Capacity Expansion (Future)
Scale inference capacity based on usage patterns from pilots. Options:
- Add DGX Spark nodes to Nginx upstream
- Purchase Z Workstations (2x with 2 cards each)
- ZGX Furry evaluation (750GB+ unified memory, 1T+ parameter models)

### Phase 4 — Monitoring & Operations (Ongoing)
GPU load dashboards, uptime monitoring, cost tracking, snapshot cadence, model management across nodes.

## Key Contacts
- **Andrew Howerton** - Infrastructure Lead
- HP Representative (hardware/pilot coordination) - TBD
- Foundation IT/IS - Jose and team (network, security, VM provisioning)

## Related Projects
- [Foundation Snowflake AI](../Foundation Snowflake AI/Overview.md) — first major workload targeting Z Workstation
- [Foundation Chat](../Foundation Chat/Overview.md) — primary app service running on infrastructure
- *Foundation Way Coach — archived 2026-04-20*
- *HP Z Workstation Pilot — merged into this project's Hardware section (2026-04-27); standalone folder removed*

---

## HP Z Workstation Pilot Detail
*(Merged from the standalone "HP Z Workstation Pilot" project on 2026-04-27. The pilot is part of this project's hardware fleet evaluation, not a separate project.)*

### Pilot Hardware
| Component | Detail |
|-----------|--------|
| **Device** | HP Z Workstation (model TBD) |
| **GPUs** | 4× NVIDIA RTX Pro 6000 Blackwell |
| **GPU Memory** | TBD (specs pending hardware arrival) |
| **System RAM** | TBD |
| **Storage** | TBD |
| **Status** | TENTATIVE — Pilot Loaner |

> Update specs once hardware arrives.

### Purchase Plan (If Validated)
- **Units:** 2× HP Z Workstations
- **GPUs per unit:** 2× NVIDIA RTX Pro 6000 Blackwell
- **Rationale:** Distributed across two machines for redundancy; expandable to 4 cards per machine if needed
- **Role:** Replace or supplement DGX Sparks for high-demand inference workloads

### Why This Hardware Matters
RTX Pro 6000 Blackwell cards provide substantially more GPU memory than the DGX Spark GB10 nodes, enabling:
- Larger models (higher parameter counts) without quantization tradeoffs
- Batch processing workloads (e.g., AI extraction across entire Snowflake tables)
- Multi-GPU inference for very large models (if NVLink supported)
- Potential for fine-tuning smaller models on Foundation data

### Pilot Role in v2 Cluster
**Current pilot role:** standalone inference node for Snowflake AI app testing. Connects directly to the Streamlit app during testing — not yet registered with the vLLM dashboard / LiteLLM proxy.

**Future role (if purchased):** two workstations join the cluster via the vLLM dashboard, alongside or replacing DGX Sparks based on benchmark results.

### Pilot Contacts
- **Andrew Howerton** — Project Lead
- HP representative (pilot coordination) — TBD

## Future Considerations
- **ZGX Furry** — 750GB+ unified memory, 1T parameter models, training/fine-tuning capability
- **GPU monitoring dashboard** — inference load tracking across DGX Sparks and future nodes
- **Foundation Way Coach S2S** — will require additional containers (Whisper, S2S pipeline, Kokoro)
- **Nginx upstream expansion** — adding nodes is a one-line config change

---

**Filed Under:** Work Projects > Active Priority
**Created:** 2026-03-05
**Last Updated:** 2026-04-27
