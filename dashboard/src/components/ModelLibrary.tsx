"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import type {
  ModelEntry, ClusterNodeStatus, ClusterGPU, VLLMInstance, NodeConfig,
  CachedModel, CacheStats, DownloadState, PendingLaunch,
} from "@/lib/types";
import { createNodeApi } from "@/lib/api";
import { DeployModal } from "./DeployModal";
import { ModelLibraryManager } from "./ModelLibraryManager";
import { HFTokenManagerModal } from "./HFTokenManagerModal";
import { HFImporterModal } from "./HFImporterModal";

const TYPE_COLORS: Record<string, string> = {
  chat:      "bg-blue-900/40 text-blue-300",
  reasoning: "bg-purple-900/40 text-purple-300",
  embedding: "bg-teal-900/40 text-teal-300",
};

const FAMILIES = ["all", "nemotron", "llama", "qwen", "mistral", "deepseek", "phi", "gemma", "bert"];

const CACHE_POLL_MS    = 15_000;
const DOWNLOAD_POLL_MS = 2_000;

interface Props {
  models: ModelEntry[];
  nodeStatuses: ClusterNodeStatus[];
  // Master-as-authority for library ops. Never null when this component renders —
  // page.tsx gates on its presence.
  masterNode: NodeConfig;
  onRefresh: () => void;
  onLibraryChanged: () => void;
  // Fires from DeployModal the instant a launch returns successfully so the
  // top-level pending-launch list can render a "Loading…" banner on the
  // targeted GPUs before the next /status poll surfaces the new instance.
  onLaunchStart: (p: PendingLaunch) => void;
}

// Keyed per (node.ip:agent_port) — used to pivot cache info by node.
function nodeKey(n: NodeConfig): string { return `${n.ip}:${n.agent_port}`; }


export function ModelLibrary({ models, nodeStatuses, masterNode, onRefresh, onLibraryChanged, onLaunchStart }: Props) {
  const [family, setFamily]         = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [deploying, setDeploying]   = useState<ModelEntry | null>(null);
  const [showManager, setShowManager] = useState(false);
  const [showTokens, setShowTokens]   = useState(false);
  const [showImporter, setShowImporter] = useState(false);

  // Per-node cache state
  const [cacheByNode, setCacheByNode] = useState<Record<string, CachedModel[]>>({});
  const [cacheStats, setCacheStats]   = useState<Record<string, CacheStats>>({});
  // Per-node download state, keyed [nodeKey][model_id]
  const [downloadsByNode, setDownloadsByNode] = useState<Record<string, Record<string, DownloadState>>>({});
  // Track which nodes we've queried; used so we know what to render even when cached list is empty
  const [nodeErrors, setNodeErrors] = useState<Record<string, string>>({});

  // The parent re-renders us every status poll tick, which gives us a fresh
  // `nodeStatuses` array reference. Deriving onlineNodes inline would then
  // produce a fresh array each render and invalidate every downstream
  // useCallback / useEffect — including the cache and download poll
  // intervals below, which would tear down and recreate on every tick.
  // Memoize against a stable signature of the *online set* so the polling
  // intervals only restart when a node actually comes online or goes offline.
  const onlineKey = nodeStatuses
    .filter(ns => !!ns.status)
    .map(ns => `${ns.node.ip}:${ns.node.agent_port}`)
    .sort()
    .join(",");
  const onlineNodes = useMemo(
    () => nodeStatuses.filter(ns => !!ns.status).map(ns => ns.node),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onlineKey],
  );
  // Master online? Some UI surfaces (Import, Manage) only work when the
  // authority is reachable. Tokens are per-node and stay available regardless.
  const masterOnline = !!nodeStatuses.find(
    ns => ns.node.ip === masterNode.ip && ns.node.agent_port === masterNode.agent_port && !!ns.status
  );

  // ── Fetch per-node cache data ─────────────────────────────────────────────

  const refreshCaches = useCallback(async () => {
    const cache: Record<string, CachedModel[]> = {};
    const stats: Record<string, CacheStats>    = {};
    const errs:  Record<string, string>        = {};
    await Promise.all(onlineNodes.map(async n => {
      const k = nodeKey(n);
      try {
        const [list, stat] = await Promise.all([
          createNodeApi(n).cacheListing(),
          createNodeApi(n).cacheStats(),
        ]);
        cache[k] = list;
        stats[k] = stat;
      } catch (e) {
        errs[k] = String(e);
      }
    }));
    setCacheByNode(cache);
    setCacheStats(stats);
    setNodeErrors(errs);
  }, [onlineNodes]);

  const refreshDownloads = useCallback(async () => {
    const out: Record<string, Record<string, DownloadState>> = {};
    await Promise.all(onlineNodes.map(async n => {
      const k = nodeKey(n);
      try {
        const list = await createNodeApi(n).hfDownloads();
        const byId: Record<string, DownloadState> = {};
        for (const d of list) byId[d.model_id] = d;
        out[k] = byId;
      } catch {
        out[k] = {};
      }
    }));
    setDownloadsByNode(out);
  }, [onlineNodes]);

  useEffect(() => {
    refreshCaches();
    const id = setInterval(refreshCaches, CACHE_POLL_MS);
    return () => clearInterval(id);
  }, [refreshCaches]);

  useEffect(() => {
    refreshDownloads();
    const id = setInterval(refreshDownloads, DOWNLOAD_POLL_MS);
    return () => clearInterval(id);
  }, [refreshDownloads]);

  // ── Actions ───────────────────────────────────────────────────────────────

  async function downloadOn(node: NodeConfig, model: ModelEntry) {
    try {
      await createNodeApi(node).hfDownloadStart(model.id);
      refreshDownloads();
    } catch (e) {
      alert(`Download start failed on ${node.name}: ${e}`);
    }
  }

  async function deleteOn(node: NodeConfig, model: ModelEntry) {
    const cached = cacheByNode[nodeKey(node)]?.find(c => c.model_id === model.id);
    const sizeStr = cached ? formatBytes(cached.size_bytes) : "unknown size";
    if (!confirm(`Delete ${model.name} from ${node.name}? Frees ${sizeStr}. The model can be re-downloaded anytime.`)) return;
    try {
      await createNodeApi(node).cacheDelete(model.id);
      refreshCaches();
    } catch (e) {
      alert(`Delete failed on ${node.name}: ${e}`);
    }
  }

  async function cancelDownloadOn(node: NodeConfig, model: ModelEntry) {
    try {
      await createNodeApi(node).hfDownloadCancel(model.id);
      refreshDownloads();
    } catch (e) {
      alert(`Cancel failed on ${node.name}: ${e}`);
    }
  }

  // ── Derivations ───────────────────────────────────────────────────────────

  const clusterGpus: ClusterGPU[] = nodeStatuses.flatMap(ns =>
    ns.status ? ns.status.gpus.map(gpu => ({ node: ns.node, gpu })) : []
  );
  const allInstances: VLLMInstance[] = nodeStatuses.flatMap(ns => ns.status?.instances ?? []);
  const runningIds = new Set(allInstances.map(i => i.model_id));

  const filtered = models.filter(m => {
    if (family !== "all" && m.family !== family) return false;
    if (typeFilter !== "all" && m.type !== typeFilter) return false;
    return true;
  });

  function cacheEntry(node: NodeConfig, model: ModelEntry): CachedModel | undefined {
    return cacheByNode[nodeKey(node)]?.find(c => c.model_id === model.id);
  }
  function downloadEntry(node: NodeConfig, model: ModelEntry): DownloadState | undefined {
    return downloadsByNode[nodeKey(node)]?.[model.id];
  }

  return (
    <>
      {!masterOnline && (
        <div className="bg-amber-950/30 border border-amber-800 rounded-xl px-4 py-2 text-xs text-amber-300 mb-2">
          Master node ({masterNode.name} · {masterNode.ip}) is unreachable — the library is read-only until it comes back. Tokens and per-node downloads still work.
        </div>
      )}

      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex flex-wrap items-center gap-3">
          <h3 className="text-sm font-semibold text-white">Model Library</h3>
          <span className="text-xs text-slate-500">· managed on <span className="text-slate-300">{masterNode.name}</span></span>

          {masterOnline && (
            <>
              <button onClick={() => setShowImporter(true)}
                className="text-xs px-2.5 py-1 rounded-lg border border-cyan-800 text-cyan-300 hover:bg-cyan-900/30 transition-colors">
                + Import from HF
              </button>
              <button onClick={() => setShowTokens(true)}
                className="text-xs px-2.5 py-1 rounded-lg border border-border text-slate-400 hover:text-white hover:border-slate-500 transition-colors">
                HF Tokens
              </button>
              <button onClick={() => setShowManager(true)}
                className="text-xs px-2.5 py-1 rounded-lg border border-border text-slate-400 hover:text-white hover:border-slate-500 transition-colors">
                Manage
              </button>
            </>
          )}

          <div className="flex gap-1 flex-wrap ml-auto">
            {["all", "chat", "reasoning", "embedding"].map(t => (
              <button key={t} onClick={() => setTypeFilter(t)}
                className={`text-xs px-2.5 py-1 rounded-full transition-colors ${typeFilter === t ? "bg-slate-600 text-white" : "text-slate-400 hover:text-white"}`}>
                {t}
              </button>
            ))}
          </div>

          <div className="flex gap-1 flex-wrap">
            {FAMILIES.map(f => (
              <button key={f} onClick={() => setFamily(f)}
                className={`text-xs px-2.5 py-1 rounded-full transition-colors ${family === f ? "bg-slate-600 text-white" : "text-slate-400 hover:text-white"}`}>
                {f}
              </button>
            ))}
          </div>
        </div>

        {/* Per-node disk usage strip */}
        {onlineNodes.length > 0 && (
          <div className="px-4 py-2 border-b border-border bg-surface/40 flex flex-wrap gap-4 text-xs">
            {onlineNodes.map(n => {
              const stats = cacheStats[nodeKey(n)];
              if (!stats) return (
                <span key={nodeKey(n)} className="text-slate-600">{n.name}: loading…</span>
              );
              const diskPct = stats.disk_total_bytes > 0 ? (stats.disk_used_bytes / stats.disk_total_bytes) * 100 : 0;
              const warn = diskPct > 85;
              return (
                <span key={nodeKey(n)} className="flex items-center gap-1.5">
                  <span className="text-slate-400">{n.name}:</span>
                  <span className="text-slate-300 font-mono">{formatBytes(stats.cache_used_bytes)}</span>
                  <span className="text-slate-600">cache ·</span>
                  <span className={warn ? "text-amber-400 font-mono" : "text-slate-500 font-mono"}>
                    {formatBytes(stats.disk_free_bytes)} free
                  </span>
                  {warn && <span className="text-amber-400">⚠</span>}
                </span>
              );
            })}
            {Object.keys(nodeErrors).length > 0 && (
              <span className="text-red-400 ml-auto">
                {Object.keys(nodeErrors).length} node(s) unreachable
              </span>
            )}
          </div>
        )}

        <div className="divide-y divide-border">
          {filtered.map(model => {
            const isRunning = runningIds.has(model.id);
            return (
              <div key={model.id} className="px-4 py-3 hover:bg-slate-800/30 transition-colors">
                <div className="flex items-start gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-white">{model.name}</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full ${TYPE_COLORS[model.type] ?? "bg-slate-700 text-slate-300"}`}>{model.type}</span>
                      {isRunning && <span className="text-xs px-2 py-0.5 rounded-full bg-blue-900/30 text-blue-300">running</span>}
                    </div>
                    <p className="text-xs text-slate-500 mt-0.5 font-mono truncate">{model.id}</p>
                    <p className="text-xs text-slate-400 mt-1 leading-relaxed">{model.description}</p>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className="text-xs text-slate-400">{model.vram_gb} GB</p>
                    <p className="text-xs text-slate-500">{model.size_b}B params</p>
                    <button
                      onClick={() => setDeploying(model)}
                      disabled={clusterGpus.length === 0}
                      className="mt-1 text-xs px-3 py-1.5 rounded-lg bg-blue-700 hover:bg-blue-600 text-white transition-colors disabled:opacity-40"
                    >
                      Deploy
                    </button>
                  </div>
                </div>

                {/* Per-node cache/download row */}
                {onlineNodes.length > 0 && (
                  <div className="mt-3 pl-0 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2 text-xs">
                    {onlineNodes.map(node => {
                      const k = nodeKey(node);
                      const cached = cacheEntry(node, model);
                      const dl = downloadEntry(node, model);
                      const busy = dl?.state === "pending" || dl?.state === "downloading";

                      return (
                        <div key={k} className="flex items-center gap-2 px-2 py-1.5 bg-slate-900/40 border border-border rounded">
                          <span className="text-slate-400 min-w-[80px] truncate">{node.name}</span>

                          {cached ? (
                            <span className="text-emerald-300 font-mono">{formatBytes(cached.size_bytes)}</span>
                          ) : busy ? (
                            <InlineProgress dl={dl!} />
                          ) : dl?.state === "error" ? (
                            <span className="text-red-400 truncate" title={dl.error ?? "download failed"}>error</span>
                          ) : (
                            <span className="text-slate-600">not cached</span>
                          )}

                          <div className="ml-auto flex items-center gap-1">
                            {!cached && !busy && (
                              <button
                                onClick={() => downloadOn(node, model)}
                                className="text-xs px-2 py-0.5 rounded bg-cyan-900/40 text-cyan-300 hover:bg-cyan-800/50"
                              >
                                Download
                              </button>
                            )}
                            {busy && (
                              <button
                                onClick={() => cancelDownloadOn(node, model)}
                                className="text-xs px-2 py-0.5 rounded bg-slate-700 text-slate-300 hover:bg-slate-600"
                              >
                                Cancel
                              </button>
                            )}
                            {cached && (
                              <button
                                onClick={() => deleteOn(node, model)}
                                className="text-xs px-2 py-0.5 rounded bg-red-900/30 text-red-300 hover:bg-red-800/40"
                              >
                                Delete
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {deploying && (
        <DeployModal
          model={deploying}
          clusterGpus={clusterGpus}
          allInstances={allInstances}
          onClose={() => setDeploying(null)}
          onLaunched={() => { setDeploying(null); onRefresh(); }}
          onLaunchStart={onLaunchStart}
        />
      )}

      {showManager && masterOnline && (
        <ModelLibraryManager
          node={masterNode}
          onClose={() => setShowManager(false)}
          onChanged={() => { onLibraryChanged(); setShowManager(false); }}
        />
      )}

      {showTokens && (
        <HFTokenManagerModal
          nodes={onlineNodes}
          onClose={() => setShowTokens(false)}
        />
      )}

      {showImporter && masterOnline && (
        <HFImporterModal
          node={masterNode}
          onClose={() => setShowImporter(false)}
          onAdded={() => { setShowImporter(false); onLibraryChanged(); }}
        />
      )}
    </>
  );
}


// ── Presentational helpers ────────────────────────────────────────────────────

function InlineProgress({ dl }: { dl: DownloadState }) {
  const pct = dl.bytes_total > 0 ? Math.min(100, Math.round((dl.bytes_done / dl.bytes_total) * 100)) : null;
  return (
    <span className="flex items-center gap-1.5">
      <span className="inline-block w-16 h-1.5 bg-slate-700 rounded-full overflow-hidden">
        <span
          className="block h-full bg-cyan-400 transition-all"
          style={{ width: pct != null ? `${pct}%` : "30%" }}
        />
      </span>
      <span className="text-slate-300 font-mono">
        {pct != null ? `${pct}%` : formatBytes(dl.bytes_done)}
      </span>
    </span>
  );
}


function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024)      return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}
