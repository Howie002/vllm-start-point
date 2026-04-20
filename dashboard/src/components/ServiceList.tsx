"use client";

import { useState } from "react";
import type { VLLMInstance, ProxyStatus, NodeConfig } from "@/lib/types";
import { createNodeApi } from "@/lib/api";

interface Props {
  instances: VLLMInstance[];
  proxy: ProxyStatus;
  node: NodeConfig;
  onRefresh: () => void;
}

function fmt(n: number | null | undefined, suffix: string) {
  return n != null ? `${n}${suffix}` : "—";
}

function contextLabel(n: number | null) {
  if (n == null) return "—";
  return n >= 1000 ? `${(n / 1000).toFixed(0)}K tokens` : `${n} tokens`;
}

export function ServiceList({ instances, proxy, node, onRefresh }: Props) {
  const [stopping, setStopping]   = useState<number | null>(null);
  const [expanded, setExpanded]   = useState<number | null>(null);

  async function handleStop(port: number) {
    setStopping(port);
    try {
      const api = createNodeApi(node);
      await api.stop(port);
      onRefresh();
    } catch (e) {
      alert(`Failed to stop: ${e}`);
    } finally {
      setStopping(null);
    }
  }

  function toggleExpand(port: number) {
    setExpanded((prev) => (prev === port ? null : port));
  }

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <h2 className="text-sm font-semibold text-white">Running Instances</h2>
        <div className="flex items-center gap-2 text-xs">
          <span className={`w-2 h-2 rounded-full ${proxy.healthy ? "bg-emerald-400" : "bg-red-500"}`} />
          <span className="text-slate-400">
            LiteLLM {proxy.healthy ? `proxy (${proxy.models.length} models)` : "proxy offline"}
          </span>
        </div>
      </div>

      {instances.length === 0 ? (
        <p className="px-4 py-6 text-sm text-slate-500 text-center">No vLLM instances running</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-slate-500 uppercase border-b border-border">
              <th className="px-4 py-2 text-left">Model</th>
              <th className="px-4 py-2 text-left">Served name</th>
              <th className="px-4 py-2 text-left">GPU</th>
              <th className="px-4 py-2 text-left">Port</th>
              <th className="px-4 py-2 text-left">Status</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {instances.map((inst) => (
              <>
                {/* Main row */}
                <tr
                  key={inst.port}
                  className="border-b border-border hover:bg-slate-800/40 cursor-pointer"
                  onClick={() => toggleExpand(inst.port)}
                >
                  <td className="px-4 py-3 text-slate-200 font-mono text-xs max-w-xs truncate">
                    {inst.model_id ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-slate-300">{inst.served_name ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-400">
                    {inst.gpu_index != null ? `GPU ${inst.gpu_index}` : "—"}
                  </td>
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
                      <span className="text-xs text-slate-600">
                        {expanded === inst.port ? "▲" : "▼"}
                      </span>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleStop(inst.port); }}
                        disabled={stopping === inst.port}
                        className="text-xs px-3 py-1 rounded bg-red-900/40 text-red-300 hover:bg-red-800/60 disabled:opacity-40 transition-colors"
                      >
                        {stopping === inst.port ? "Stopping…" : "Stop"}
                      </button>
                    </div>
                  </td>
                </tr>

                {/* Expanded detail row */}
                {expanded === inst.port && (
                  <tr key={`${inst.port}-detail`} className="border-b border-border bg-slate-900/60">
                    <td colSpan={6} className="px-6 py-4">
                      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">

                        <div>
                          <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Context window</p>
                          <p className="text-sm font-medium text-white">{contextLabel(inst.context_length)}</p>
                          {inst.context_length != null && (
                            <p className="text-xs text-slate-500 mt-0.5">
                              {inst.context_length.toLocaleString()} tokens max
                            </p>
                          )}
                        </div>

                        <div>
                          <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">GPU memory reserved</p>
                          <p className="text-sm font-medium text-white">
                            {inst.gpu_memory_utilization != null
                              ? `${Math.round(inst.gpu_memory_utilization * 100)}%`
                              : "—"}
                          </p>
                          <p className="text-xs text-slate-500 mt-0.5">of total VRAM pre-allocated</p>
                        </div>

                        <div>
                          <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Quantization</p>
                          <p className="text-sm font-medium text-white">
                            {inst.quantization ?? "none (bf16)"}
                          </p>
                        </div>

                        <div>
                          <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Tensor parallel</p>
                          <p className="text-sm font-medium text-white">
                            {inst.tensor_parallel_size != null ? `${inst.tensor_parallel_size}× GPUs` : "1× GPU"}
                          </p>
                        </div>

                        <div>
                          <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Parallel slots</p>
                          <p className="text-sm font-medium text-white">
                            {inst.max_num_seqs != null ? inst.max_num_seqs : "256 (default)"}
                          </p>
                          <p className="text-xs text-slate-500 mt-0.5">max concurrent requests</p>
                        </div>

                        <div>
                          <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Direct endpoint</p>
                          <p className="text-xs font-mono text-cyan-400 break-all">
                            http://{node.ip}:{inst.port}/v1
                          </p>
                          <p className="text-xs text-slate-500 mt-0.5">PID {inst.pid}</p>
                        </div>

                      </div>
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
