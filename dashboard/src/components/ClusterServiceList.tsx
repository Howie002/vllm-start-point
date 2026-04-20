"use client";

import { useState } from "react";
import type { ClusterNodeStatus } from "@/lib/types";
import { createNodeApi } from "@/lib/api";

interface Props {
  nodeStatuses: ClusterNodeStatus[];
  onRefreshAll: () => void;
}

export function ClusterServiceList({ nodeStatuses, onRefreshAll }: Props) {
  const [stopping, setStopping] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const allInstances = nodeStatuses.flatMap(ns =>
    (ns.status?.instances ?? []).map(inst => ({ node: ns.node, inst }))
  );
  const proxyHealthy = nodeStatuses.some(ns => ns.status?.proxy.healthy);
  const proxyModelCount = nodeStatuses.reduce((a, ns) => a + (ns.status?.proxy.models.length ?? 0), 0);

  async function handleStop(nodeKey: string, instPort: number) {
    const rowKey = `${nodeKey}:${instPort}`;
    setStopping(rowKey);
    try {
      const ns = nodeStatuses.find(n => `${n.node.ip}:${n.node.agent_port}` === nodeKey);
      if (!ns) return;
      await createNodeApi(ns.node).stop(instPort);
      onRefreshAll();
    } catch (e) {
      alert(`Failed to stop: ${e}`);
    } finally {
      setStopping(null);
    }
  }

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <h2 className="text-sm font-semibold text-white">Running Instances</h2>
        <div className="flex items-center gap-2 text-xs">
          <span className={`w-2 h-2 rounded-full ${proxyHealthy ? "bg-emerald-400" : "bg-red-500"}`} />
          <span className="text-slate-400">
            LiteLLM {proxyHealthy ? `proxy (${proxyModelCount} models)` : "proxy offline"}
          </span>
        </div>
      </div>

      {allInstances.length === 0 ? (
        <p className="px-4 py-6 text-sm text-slate-500 text-center">No vLLM instances running</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-slate-500 uppercase border-b border-border">
              <th className="px-4 py-2 text-left">Node</th>
              <th className="px-4 py-2 text-left">Model</th>
              <th className="px-4 py-2 text-left">Served name</th>
              <th className="px-4 py-2 text-left">GPU</th>
              <th className="px-4 py-2 text-left">Port</th>
              <th className="px-4 py-2 text-left">Status</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {allInstances.map(({ node, inst }) => {
              const nodeKey  = `${node.ip}:${node.agent_port}`;
              const rowKey   = `${nodeKey}:${inst.port}`;
              const isOpen   = expanded === rowKey;
              const isStopping = stopping === rowKey;
              return (
                <>
                  <tr
                    key={rowKey}
                    className="border-b border-border hover:bg-slate-800/40 cursor-pointer"
                    onClick={() => setExpanded(isOpen ? null : rowKey)}
                  >
                    <td className="px-4 py-3">
                      <span className="text-xs px-2 py-0.5 rounded bg-slate-800 text-slate-300 whitespace-nowrap">{node.name}</span>
                    </td>
                    <td className="px-4 py-3 text-slate-200 font-mono text-xs max-w-[160px] truncate">{inst.model_id ?? "—"}</td>
                    <td className="px-4 py-3 text-slate-300">{inst.served_name ?? "—"}</td>
                    <td className="px-4 py-3 text-slate-400">{inst.gpu_index != null ? `GPU ${inst.gpu_index}` : "—"}</td>
                    <td className="px-4 py-3 text-slate-400">{inst.port}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full ${
                        inst.status === "healthy"
                          ? "bg-emerald-900/40 text-emerald-300"
                          : "bg-amber-900/40 text-amber-300"
                      }`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${
                          inst.status === "healthy" ? "bg-emerald-400" : "bg-amber-400 animate-pulse"
                        }`} />
                        {inst.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <span className="text-xs text-slate-600">{isOpen ? "▲" : "▼"}</span>
                        <button
                          onClick={e => { e.stopPropagation(); handleStop(nodeKey, inst.port); }}
                          disabled={isStopping}
                          className="text-xs px-3 py-1 rounded bg-red-900/40 text-red-300 hover:bg-red-800/60 disabled:opacity-40 transition-colors"
                        >
                          {isStopping ? "Stopping…" : "Stop"}
                        </button>
                      </div>
                    </td>
                  </tr>

                  {isOpen && (
                    <tr key={`${rowKey}-detail`} className="border-b border-border bg-slate-900/60">
                      <td colSpan={7} className="px-6 py-4">
                        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
                          <div>
                            <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Context window</p>
                            <p className="text-sm font-medium text-white">
                              {inst.context_length != null ? `${(inst.context_length / 1000).toFixed(0)}K` : "—"}
                            </p>
                            <p className="text-xs text-slate-500 mt-0.5">{inst.context_length?.toLocaleString()} tokens</p>
                          </div>
                          <div>
                            <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">GPU memory</p>
                            <p className="text-sm font-medium text-white">
                              {inst.gpu_memory_utilization != null ? `${Math.round(inst.gpu_memory_utilization * 100)}%` : "—"}
                            </p>
                            <p className="text-xs text-slate-500 mt-0.5">reserved of total VRAM</p>
                          </div>
                          <div>
                            <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Quantization</p>
                            <p className="text-sm font-medium text-white">{inst.quantization ?? "none (bf16)"}</p>
                          </div>
                          <div>
                            <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Tensor parallel</p>
                            <p className="text-sm font-medium text-white">
                              {inst.tensor_parallel_size != null ? `${inst.tensor_parallel_size}× GPUs` : "1× GPU"}
                            </p>
                          </div>
                          <div>
                            <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Parallel slots</p>
                            <p className="text-sm font-medium text-white">{inst.max_num_seqs ?? "256 (default)"}</p>
                            <p className="text-xs text-slate-500 mt-0.5">max concurrent requests</p>
                          </div>
                          <div>
                            <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Direct endpoint</p>
                            <p className="text-xs font-mono text-cyan-400 break-all">http://{node.ip}:{inst.port}/v1</p>
                            <p className="text-xs text-slate-500 mt-0.5">PID {inst.pid}</p>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
