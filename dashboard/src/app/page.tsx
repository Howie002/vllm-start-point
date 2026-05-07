"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { NodeConfig, ModelEntry, ClusterNodeStatus, PendingLaunch } from "@/lib/types";
import { fetchNodes, createNodeApi, findMasterNode } from "@/lib/api";
import { ClusterGPUView } from "@/components/ClusterGPUView";
import { ClusterServiceList } from "@/components/ClusterServiceList";
import { NodeCard } from "@/components/NodeCard";
import { ModelLibrary } from "@/components/ModelLibrary";
import { AddNodeModal } from "@/components/AddNodeModal";
import { PortTreeView } from "@/components/PortTreeView";
import { AnalyticsView } from "@/components/AnalyticsView";
import { TestingView } from "@/components/TestingView";
import { SettingsView } from "@/components/SettingsView";
import { UpdateBadge } from "@/components/UpdateBadge";

type Tab = "overview" | "endpoints" | "analytics" | "testing" | "settings";

// Status poll cadence. Each tick fans out one /status call per registered
// node; the agent caches the response for ~3s so concurrent dashboards share
// work, but the cadence still bounds how often each agent re-runs its
// nvidia-smi / psutil sweep. 15s is fine for an ops dashboard and noticeably
// reduces baseline CPU on the GPU nodes.
const POLL_MS = 15000;

// Hard cap on how long a pending launch can sit unmatched before we drop it
// from the optimistic UI state. Picked to comfortably exceed the worst-case
// load time we see in practice (large quant'd 70B+ models can take 2-3 min)
// while still clearing out ghost banners from launches that failed silently.
const PENDING_LAUNCH_TIMEOUT_MS = 5 * 60 * 1000;

export default function Page() {
  const [nodes, setNodes]                 = useState<NodeConfig[]>([]);
  const [nodeStatuses, setNodeStatuses]   = useState<ClusterNodeStatus[]>([]);
  const [library, setLibrary]             = useState<ModelEntry[]>([]);
  const [loading, setLoading]             = useState(true);
  const [showAddNode, setShowAddNode]     = useState(false);
  const [tab, setTab]                     = useState<Tab>("overview");
  const [pendingLaunches, setPendingLaunches] = useState<PendingLaunch[]>([]);

  // Load node list once on mount
  useEffect(() => {
    fetchNodes().then(n => { setNodes(n); setLoading(false); });
  }, []);

  // Poll all nodes for status. Two safety rails:
  //   * skip-if-busy: if a previous tick is still in flight (slow node or
  //     visibilitychange firing while the interval also ticks), drop the
  //     overlapping call instead of letting concurrent fan-outs pile up.
  //   * latest-only: tag each fan-out with a monotonic id and refuse to
  //     publish a result that isn't from the most recent dispatch — guards
  //     against an older slow tick landing after a newer fast one and
  //     overwriting state with stale data.
  const inFlightRef   = useRef(false);
  const requestIdRef  = useRef(0);
  const refreshAll = useCallback(async () => {
    if (nodes.length === 0) return;
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    const myId = ++requestIdRef.current;
    try {
      const updated = await Promise.all(
        nodes.map(async (node) => {
          try {
            const status = await createNodeApi(node).status();
            return { node, status, error: null } as ClusterNodeStatus;
          } catch (e) {
            return { node, status: null, error: String(e) } as ClusterNodeStatus;
          }
        })
      );
      if (myId === requestIdRef.current) {
        setNodeStatuses(updated);
      }
    } finally {
      inFlightRef.current = false;
    }
  }, [nodes]);

  // Polling is paused while the tab is backgrounded so a forgotten tab in a
  // window switcher doesn't keep the cluster busy. When the tab becomes
  // visible again we kick an immediate refresh so the user sees fresh state
  // without waiting up to POLL_MS.
  useEffect(() => {
    if (nodes.length === 0) return;
    const tick = () => { if (!document.hidden) refreshAll(); };
    tick();
    const id = setInterval(tick, POLL_MS);
    const onVisibility = () => { if (!document.hidden) refreshAll(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refreshAll, nodes]);

  // Library is master-authoritative. Every add/edit/delete goes to master; the
  // dashboard reads from master so there's one source of truth. Fallback to
  // first online node only in the transient window before proxy status lands.
  const masterNode = findMasterNode(nodes, nodeStatuses);
  const refreshLibrary = useCallback(() => {
    if (!masterNode) return;
    createNodeApi(masterNode).library().then(setLibrary).catch(() => setLibrary([]));
  }, [masterNode]);

  useEffect(() => { refreshLibrary(); }, [refreshLibrary]);

  // Prune pending launches whenever statuses refresh: drop any entry whose
  // target served_name now appears in the cluster as a healthy instance, or
  // that has been pending past the hard timeout (probably a silent failure).
  // Matching on served_name + node is enough because the agent only emits
  // one gpu_index per instance even for tensor-parallel deploys, so trying
  // to match on gpu_index would prematurely clear multi-GPU banners.
  useEffect(() => {
    if (pendingLaunches.length === 0) return;
    const now = Date.now();
    const next = pendingLaunches.filter(p => {
      if (now - p.startedAt > PENDING_LAUNCH_TIMEOUT_MS) return false;
      const ns = nodeStatuses.find(
        s => s.node.ip === p.nodeIp && s.node.agent_port === p.nodeAgentPort,
      );
      const inst = ns?.status?.instances.find(i => i.served_name === p.servedName);
      return !(inst && inst.status === "healthy");
    });
    if (next.length !== pendingLaunches.length) setPendingLaunches(next);
  }, [nodeStatuses, pendingLaunches]);

  const handleLaunchStart = useCallback((p: PendingLaunch) => {
    setPendingLaunches(prev => {
      // Replace any prior pending entry for the same target — re-launching
      // a failed/aborted attempt should reset the elapsed timer rather than
      // stacking duplicate banners.
      const without = prev.filter(
        x => !(x.nodeIp === p.nodeIp && x.nodeAgentPort === p.nodeAgentPort && x.servedName === p.servedName),
      );
      return [...without, p];
    });
  }, []);

  function handleNodeAdded() {
    fetchNodes().then(setNodes);
  }

  const onlineCount = nodeStatuses.filter(ns => !!ns.status).length;

  return (
    <div className="max-w-7xl mx-auto px-4 py-8 space-y-4">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">vLLM Dashboard</h1>
          <p className="text-xs text-slate-500 mt-0.5">
            {loading
              ? "Loading…"
              : `${nodes.length} node${nodes.length !== 1 ? "s" : ""} configured · ${onlineCount} online`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <UpdateBadge nodeStatuses={nodeStatuses} onClick={() => setTab("settings")} />
          <button
            onClick={() => setShowAddNode(true)}
            className="text-xs px-3 py-1.5 rounded-lg border border-border text-slate-400 hover:text-white hover:border-slate-500 transition-colors"
          >
            + Add node
          </button>
        </div>
      </div>

      {showAddNode && (
        <AddNodeModal
          masterIp={nodes[0]?.ip ?? ""}
          onClose={() => setShowAddNode(false)}
          onAdded={handleNodeAdded}
        />
      )}

      {!loading && nodes.length === 0 && (
        <div className="bg-amber-900/20 border border-amber-700 rounded-xl px-4 py-3 text-sm text-amber-300">
          No nodes configured. Run <code className="font-mono">./node.sh setup</code> on the GPU machine, then click + Add node.
        </div>
      )}

      {/* Tab nav */}
      {nodes.length > 0 && (
        <div className="flex items-center gap-1 border-b border-border">
          {(["overview", "endpoints", "analytics", "testing", "settings"] as Tab[]).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`text-xs px-3 py-2 border-b-2 transition-colors ${
                tab === t
                  ? "border-cyan-400 text-white"
                  : "border-transparent text-slate-500 hover:text-slate-300"
              }`}
            >
              {t === "overview" ? "Overview"
                : t === "endpoints" ? "Endpoints"
                : t === "analytics" ? "Analytics"
                : t === "testing" ? "Testing"
                : "Settings"}
            </button>
          ))}
        </div>
      )}

      {tab === "overview" && (
        <>
          {/* Cluster GPU pool */}
          {nodeStatuses.length > 0 && (
            <ClusterGPUView nodeStatuses={nodeStatuses} pendingLaunches={pendingLaunches} />
          )}

          {/* Running instances across all nodes */}
          {nodeStatuses.length > 0 && (
            <ClusterServiceList nodeStatuses={nodeStatuses} onRefreshAll={refreshAll} />
          )}

          {/* Per-node management: stack templates + agent controls */}
          {nodeStatuses.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs text-slate-500 font-medium uppercase tracking-wider px-1">Node Management</p>
              {nodeStatuses.map(({ node, status, error }) => (
                <NodeCard
                  key={`${node.ip}:${node.agent_port}`}
                  node={node}
                  status={status}
                  error={error}
                  onRefresh={refreshAll}
                  onNodesChanged={handleNodeAdded}
                />
              ))}
            </div>
          )}

          {/* Model library — master-authoritative; empty when master is offline */}
          {masterNode && (
            <ModelLibrary
              models={library}
              nodeStatuses={nodeStatuses}
              masterNode={masterNode}
              onRefresh={refreshAll}
              onLibraryChanged={refreshLibrary}
              onLaunchStart={handleLaunchStart}
            />
          )}
        </>
      )}

      {tab === "endpoints" && nodeStatuses.length > 0 && (
        <PortTreeView nodeStatuses={nodeStatuses} />
      )}

      {tab === "analytics" && nodes.length > 0 && (
        <AnalyticsView nodes={nodes} />
      )}

      {tab === "testing" && nodeStatuses.length > 0 && (
        <TestingView nodeStatuses={nodeStatuses} />
      )}

      {tab === "settings" && nodeStatuses.length > 0 && (
        <SettingsView nodeStatuses={nodeStatuses} onRefresh={refreshAll} />
      )}

    </div>
  );
}
