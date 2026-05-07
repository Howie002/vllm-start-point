import type {
  FullStatus, ModelEntry, LaunchRequest, NodeConfig, StackConfig, StackModelConfig,
  PreflightResult, RepackResult, RepackAssignment, MetricsQueryResult,
  HFTokenStatus, HFLookup, CachedModel, CacheStats, DownloadState,
  UpdateStatus, UpdateConfig, DynamicLog,
} from "./types";

// Build a direct URL to a node's agent (browser calls this cross-origin)
function agentBase(node: NodeConfig): string {
  if (node.ip === "localhost" || node.ip === "127.0.0.1") {
    // Route through Next.js proxy to avoid mixed-content issues in dev
    return "/api/agent";
  }
  return `http://${node.ip}:${node.agent_port}`;
}

// Default timeouts in ms. Polling fans out to every configured node every few
// seconds; without a hard cap, a single dead node holds requests open for the
// browser's default TCP timeout (~90s on Firefox), which piles up faster than
// they retire and freezes the tab. GET is bounded tighter than POST/DELETE
// because reads are auto-fired on a schedule while writes are user-initiated.
const DEFAULT_GET_TIMEOUT_MS  = 6000;
const DEFAULT_POST_TIMEOUT_MS = 30000;
const DEFAULT_DEL_TIMEOUT_MS  = 30000;

async function get<T>(base: string, path: string, timeoutMs = DEFAULT_GET_TIMEOUT_MS): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json();
}

async function post<T>(base: string, path: string, body: unknown, timeoutMs = DEFAULT_POST_TIMEOUT_MS): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail || `POST ${path} → ${res.status}`);
  }
  return res.json();
}

async function del<T>(base: string, path: string, timeoutMs = DEFAULT_DEL_TIMEOUT_MS): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method: "DELETE",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`DELETE ${path} → ${res.status}`);
  return res.json();
}

export function createNodeApi(node: NodeConfig) {
  const base = agentBase(node);
  return {
    status:           ()                                   => get<FullStatus>                    (base, "/status"),
    library:          ()                                   => get<ModelEntry[]>                  (base, "/models/library"),
    launch:           (req: LaunchRequest)                 => post<{ pid: number; port: number }>(base, "/instances/launch", req),
    stop:             (port: number)                       => del<{ stopped: boolean }>          (base, `/instances/${port}`),
    configs:          ()                                   => get<StackConfig[]>                 (base, "/configs"),
    preflightConfig:  (name: string)                       => get<PreflightResult>              (base, `/configs/${encodeURIComponent(name)}/preflight`),
    repackConfig:     (name: string)                       => get<RepackResult>                 (base, `/configs/${encodeURIComponent(name)}/repack`),
    applyRepack:      (name: string, a: RepackAssignment[])=> post<object>                      (base, `/configs/${encodeURIComponent(name)}/repack/apply`, { assignments: a }),
    activateConfig:   (name: string)                       => post<object>(base, `/configs/${encodeURIComponent(name)}/activate`, {}),
    deactivateConfig: (name: string)                       => post<object>(base, `/configs/${encodeURIComponent(name)}/deactivate`, {}),
    deleteConfig:     (name: string)                       => del<{ deleted: string }>           (base, `/configs/${encodeURIComponent(name)}`),
    snapshotConfig:   (name: string, description: string)  => post<{ saved: string }>            (base, "/configs/snapshot", { name, description }),
    saveConfig:       (cfg: StackConfig)                    => post<{ saved: string }>            (base, "/configs", cfg),
    restartAgent:         ()                                        => post<{ restarting: boolean }>(base, "/agent/restart", {}),
    stopAgent:            ()                                        => post<{ stopping: boolean }> (base, "/agent/stop", {}),
    restartDashboard:     ()                                        => post<{ restarting: boolean }>(base, "/dashboard/restart", {}),
    stopDashboard:        ()                                        => post<{ stopped: boolean }>  (base, "/dashboard/stop", {}),
    libraryAll:           ()                                        => get<ModelEntry[]>           (base, "/models/library/all"),
    toggleModel:          (id: string, enabled: boolean)           => fetch(`${base}/models/library/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }) }).then(r => r.json()) as Promise<ModelEntry>,
    addModel:             (entry: Partial<ModelEntry>)             => post<ModelEntry>             (base, "/models/library", entry),
    deleteModel:          (id: string)                             => del<{ deleted: string }>     (base, `/models/library/${encodeURIComponent(id)}`),
    metrics:              (range: string, resolution: string)      => get<MetricsQueryResult>      (base, `/metrics/query?range=${range}&resolution=${resolution}`),

    // Tail of the per-instance vLLM log captured during launch. Used to
    // diagnose silent crashes — vLLM dies during init, dashboard never sees
    // a healthy instance, and the only evidence is in this file.
    dynamicLog:           (port: number, tail = 200)                => get<DynamicLog>             (base, `/logs/dynamic/${port}?tail=${tail}`),

    // HF integration — per node
    hfTokenStatus:   ()                      => get<HFTokenStatus> (base, "/models/hf/token"),
    hfTokenSet:      (token: string)         => post<HFTokenStatus>(base, "/models/hf/token", { token }),
    hfTokenClear:    ()                      => del<HFTokenStatus> (base, "/models/hf/token"),
    hfLookup:        (model_id: string)      => get<HFLookup>      (base, `/models/hf/lookup/${encodeURIComponent(model_id)}`),
    hfPreflight:     (model_id: string)      => get<HFLookup>      (base, `/models/hf/preflight/${encodeURIComponent(model_id)}`),
    cacheListing:    ()                      => get<CachedModel[]> (base, "/models/cache"),
    cacheStats:      ()                      => get<CacheStats>    (base, "/models/cache/stats"),
    cacheDelete:     (model_id: string)      => del<{ deleted: boolean; bytes_freed?: number }>(base, `/models/cache/${encodeURIComponent(model_id)}`),
    hfDownloadStart:  (model_id: string)     => post<DownloadState>(base, "/models/hf/download", { model_id }),
    hfDownloadStatus: (model_id: string)     => get<DownloadState> (base, `/models/hf/download/${encodeURIComponent(model_id)}`),
    hfDownloadCancel: (model_id: string)     => del<{ canceled: boolean }>(base, `/models/hf/download/${encodeURIComponent(model_id)}`),
    hfDownloads:      ()                     => get<DownloadState[]>(base, "/models/hf/downloads"),

    // Self-update — per node git state vs origin/<branch>
    updateStatus:     ()                               => get<UpdateStatus>  (base, "/update/status"),
    updateCheck:      ()                               => post<UpdateStatus> (base, "/update/check", {}),
    updatePull:       ()                               => post<{ pulled: boolean; restarting: boolean; from?: string; to?: string; changed?: string[]; detail?: string }>(base, "/update/pull", {}),
    updateConfigGet:  ()                               => get<UpdateConfig>  (base, "/update/config"),
    updateConfigSet:  (repo_url: string, branch: string, auto_pull_on_start: boolean) => post<{ updated: boolean; repo_url: string; branch: string; auto_pull_on_start: boolean }>(base, "/update/config", { repo_url, branch, auto_pull_on_start }),
  };
}

// Fetch the node list from the server-side config
export async function fetchNodes(): Promise<NodeConfig[]> {
  try {
    const res = await fetch("/api/nodes", {
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [{ name: "Local", ip: "localhost", agent_port: 5000 }];
    return res.json();
  } catch {
    return [{ name: "Local", ip: "localhost", agent_port: 5000 }];
  }
}

// Identify the master node from a list of nodes + their statuses. The master
// is whichever node hosts the cluster LiteLLM proxy; every agent reports that
// same URL via /status, so we just match the proxy's host back to a node IP.
//
// Library operations route to the master so add/edit/delete go to one place
// (master is the authority). Fallback: if no proxy URL is reachable yet, use
// the first online node so first-run scenarios still work.
import type { ClusterNodeStatus } from "./types";
export function findMasterNode(nodes: NodeConfig[], nodeStatuses: ClusterNodeStatus[]): NodeConfig | null {
  for (const ns of nodeStatuses) {
    const url = ns.status?.proxy.url;
    if (!url) continue;
    const host = url.replace(/^https?:\/\//, "").split(":")[0];
    const match = nodes.find(n => n.ip === host);
    if (match) return match;
  }
  return nodeStatuses.find(ns => !!ns.status)?.node ?? nodes[0] ?? null;
}


// Rename a registered node. Routes through Next.js so the canonical nodes[] on
// master gets updated regardless of which dashboard the user is browsing.
export async function renameNode(ip: string, agent_port: number, name: string): Promise<void> {
  const res = await fetch("/api/nodes/rename", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ip, agent_port, name }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail || `rename → ${res.status}`);
  }
}

// Update a registered node's name, IP, and / or agent port. Same topology as
// renameNode — Next.js routes the change to the master's node_config.json.
export async function editNode(args: {
  ip: string;
  agent_port: number;
  name: string;
  new_ip: string;
  new_agent_port: number;
}): Promise<void> {
  const res = await fetch("/api/nodes/edit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail || `edit → ${res.status}`);
  }
}
