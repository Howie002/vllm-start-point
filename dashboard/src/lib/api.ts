import type { FullStatus, ModelEntry, LaunchRequest, NodeConfig, StackConfig, StackModelConfig, PreflightResult, RepackResult, RepackAssignment } from "./types";

// Build a direct URL to a node's agent (browser calls this cross-origin)
function agentBase(node: NodeConfig): string {
  if (node.ip === "localhost" || node.ip === "127.0.0.1") {
    // Route through Next.js proxy to avoid mixed-content issues in dev
    return "/api/agent";
  }
  return `http://${node.ip}:${node.agent_port}`;
}

async function get<T>(base: string, path: string): Promise<T> {
  const res = await fetch(`${base}${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json();
}

async function post<T>(base: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail || `POST ${path} → ${res.status}`);
  }
  return res.json();
}

async function del<T>(base: string, path: string): Promise<T> {
  const res = await fetch(`${base}${path}`, { method: "DELETE" });
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
  };
}

// Fetch the node list from the server-side config
export async function fetchNodes(): Promise<NodeConfig[]> {
  const res = await fetch("/api/nodes", { cache: "no-store" });
  if (!res.ok) return [{ name: "Local", ip: "localhost", agent_port: 5000 }];
  return res.json();
}
