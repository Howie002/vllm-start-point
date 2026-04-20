"use client";

import { useState, useEffect, useCallback } from "react";
import type { NodeConfig, ModelEntry } from "@/lib/types";
import { fetchNodes, createNodeApi } from "@/lib/api";
import { NodeCard } from "@/components/NodeCard";
import { AddNodeModal } from "@/components/AddNodeModal";

export default function Page() {
  const [nodes, setNodes]         = useState<NodeConfig[]>([]);
  const [library, setLibrary]     = useState<ModelEntry[]>([]);
  const [loading, setLoading]     = useState(true);
  const [showAddNode, setShowAddNode] = useState(false);

  // Fetch node list from server config
  useEffect(() => {
    fetchNodes().then((n) => {
      setNodes(n);
      setLoading(false);

      // Fetch model library from first node that responds
      for (const node of n) {
        const api = createNodeApi(node);
        api.library()
          .then(setLibrary)
          .catch(() => {});
        break;
      }
    });
  }, []);

  const refreshLibrary = useCallback(() => {
    for (const node of nodes) {
      const api = createNodeApi(node);
      api.library().then(setLibrary).catch(() => {});
      break;
    }
  }, [nodes]);

  function handleNodeAdded() {
    fetchNodes().then(setNodes);
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">vLLM Dashboard</h1>
          <p className="text-xs text-slate-500 mt-0.5">
            {loading ? "Loading node config…" : `${nodes.length} node${nodes.length !== 1 ? "s" : ""} configured`}
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

      {/* Nodes */}
      {!loading && nodes.length === 0 && (
        <div className="bg-amber-900/20 border border-amber-700 rounded-xl px-4 py-3 text-sm text-amber-300">
          No nodes configured. Run{" "}
          <code className="font-mono">./node.sh setup</code> on the GPU machine and add it via{" "}
          <code className="font-mono">./node.sh add-node</code>.
        </div>
      )}

      <div className="space-y-4">
        {nodes.map((node, i) => (
          <NodeCard
            key={`${node.ip}:${node.agent_port}`}
            node={node}
            library={library}
            defaultOpen={i === 0}
            onLibraryChanged={refreshLibrary}
          />
        ))}
      </div>
    </div>
  );
}
