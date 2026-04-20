"use client";

import { useState, useEffect, useCallback } from "react";
import type { NodeConfig, ModelEntry, ClusterNodeStatus } from "@/lib/types";
import { fetchNodes, createNodeApi } from "@/lib/api";
import { ClusterGPUView } from "@/components/ClusterGPUView";
import { ClusterServiceList } from "@/components/ClusterServiceList";
import { NodeCard } from "@/components/NodeCard";
import { ModelLibrary } from "@/components/ModelLibrary";
import { AddNodeModal } from "@/components/AddNodeModal";

const POLL_MS = 8000;

export default function Page() {
  const [nodes, setNodes]                 = useState<NodeConfig[]>([]);
  const [nodeStatuses, setNodeStatuses]   = useState<ClusterNodeStatus[]>([]);
  const [library, setLibrary]             = useState<ModelEntry[]>([]);
  const [loading, setLoading]             = useState(true);
  const [showAddNode, setShowAddNode]     = useState(false);

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

  // Fetch enabled model library from first responding node
  const refreshLibrary = useCallback(() => {
    for (const node of nodes) {
      createNodeApi(node).library().then(setLibrary).catch(() => {});
      break;
    }
  }, [nodes]);

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
            />
          ))}
        </div>
      )}

      {/* Model library — cluster-wide deploy */}
      {library.length > 0 && (
        <ModelLibrary
          models={library}
          nodeStatuses={nodeStatuses}
          onRefresh={refreshAll}
          onLibraryChanged={refreshLibrary}
        />
      )}

    </div>
  );
}
