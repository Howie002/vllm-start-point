"use client";

import { useState, useEffect, useCallback } from "react";
import type { NodeConfig, ModelEntry, ClusterNodeStatus } from "@/lib/types";
import { fetchNodes, createNodeApi, findMasterNode } from "@/lib/api";
import { ClusterGPUView } from "@/components/ClusterGPUView";
import { ClusterServiceList } from "@/components/ClusterServiceList";
import { NodeCard } from "@/components/NodeCard";
import { ModelLibrary } from "@/components/ModelLibrary";
import { AddNodeModal } from "@/components/AddNodeModal";
import { PortTreeView } from "@/components/PortTreeView";
import { AnalyticsView } from "@/components/AnalyticsView";

type Tab = "overview" | "endpoints" | "analytics";

const POLL_MS = 8000;

export default function Page() {
  const [nodes, setNodes]                 = useState<NodeConfig[]>([]);
  const [nodeStatuses, setNodeStatuses]   = useState<ClusterNodeStatus[]>([]);
  const [library, setLibrary]             = useState<ModelEntry[]>([]);
  const [loading, setLoading]             = useState(true);
  const [showAddNode, setShowAddNode]     = useState(false);
  const [tab, setTab]                     = useState<Tab>("overview");

  // Load node list once on mount
  useEffect(() => {
    fetchNodes().then(n => { setNodes(n); setLoading(false); });
  }, []);

  // Poll all nodes for status
  const refreshAll = useCallback(async () => {
    if (nodes.length === 0) return;
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
    setNodeStatuses(updated);
  }, [nodes]);

  useEffect(() => {
    if (nodes.length === 0) return;
    refreshAll();
    const id = setInterval(refreshAll, POLL_MS);
    return () => clearInterval(id);
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
        <button
          onClick={() => setShowAddNode(true)}
          className="text-xs px-3 py-1.5 rounded-lg border border-border text-slate-400 hover:text-white hover:border-slate-500 transition-colors"
        >
          + Add node
        </button>
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
          {(["overview", "endpoints", "analytics"] as Tab[]).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`text-xs px-3 py-2 border-b-2 transition-colors ${
                tab === t
                  ? "border-cyan-400 text-white"
                  : "border-transparent text-slate-500 hover:text-slate-300"
              }`}
            >
              {t === "overview" ? "Overview" : t === "endpoints" ? "Endpoints" : "Analytics"}
            </button>
          ))}
        </div>
      )}

      {tab === "overview" && (
        <>
          {/* Cluster GPU pool */}
          {nodeStatuses.length > 0 && (
            <ClusterGPUView nodeStatuses={nodeStatuses} />
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

    </div>
  );
}
