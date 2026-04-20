"use client";

import { useState } from "react";
import type { GPU, ClusterNodeStatus, NodeConfig } from "@/lib/types";

function vramPct(gpu: GPU) { return gpu.vram_total_mb > 0 ? Math.round((gpu.vram_used_mb / gpu.vram_total_mb) * 100) : 0; }
function vramGB(mb: number) { return (mb / 1024).toFixed(1); }
function barColor(pct: number) { return pct < 60 ? "bg-emerald-500" : pct < 85 ? "bg-amber-400" : "bg-red-500"; }
function tempColor(c: number) { return c < 70 ? "text-emerald-400" : c < 85 ? "text-amber-400" : "text-red-400"; }
function fmt(val: number | null | undefined, fallback = "—") { return val == null ? fallback : String(Math.round(val)); }

interface FlatGPU {
  nodeKey: string;
  node: NodeConfig;
  ns: ClusterNodeStatus;
  gpu: GPU;
}

interface StatBoxProps {
  label: string; value: string; sub?: string; valueClass?: string;
  bar?: { pct: number; color: string };
}
function StatBox({ label, value, sub, valueClass = "text-white", bar }: StatBoxProps) {
  return (
    <div className="bg-slate-800/60 rounded-lg px-3 py-2.5 space-y-1">
      <p className="text-xs text-slate-500 uppercase tracking-wider">{label}</p>
      <p className={`text-sm font-semibold leading-tight ${valueClass}`}>{value}</p>
      {sub && <p className="text-xs text-slate-500">{sub}</p>}
      {bar && (
        <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden mt-1">
          <div className={`h-full rounded-full ${bar.color}`} style={{ width: `${Math.min(bar.pct, 100)}%` }} />
        </div>
      )}
    </div>
  );
}

interface Props {
  nodeStatuses: ClusterNodeStatus[];
}

export function ClusterGPUView({ nodeStatuses }: Props) {
  const [expanded, setExpanded] = useState<{ nodeKey: string; gpuIndex: number } | null>(null);

  // Flatten all GPUs from all online nodes into one list
  const flatGpus: FlatGPU[] = nodeStatuses.flatMap(ns => {
    if (!ns.status) return [];
    const nodeKey = `${ns.node.ip}:${ns.node.agent_port}`;
    return ns.status.gpus.map(gpu => ({ nodeKey, node: ns.node, ns, gpu }));
  });

  const offlineNodes = nodeStatuses.filter(ns => !ns.status);

  const totalVramMb = flatGpus.reduce((a, fg) => a + fg.gpu.vram_total_mb, 0);
  const usedVramMb  = flatGpus.reduce((a, fg) => a + fg.gpu.vram_used_mb, 0);
  const onlineCount = nodeStatuses.filter(ns => !!ns.status).length;

  const expandedEntry = expanded
    ? flatGpus.find(fg => fg.nodeKey === expanded.nodeKey && fg.gpu.index === expanded.gpuIndex) ?? null
    : null;

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <h2 className="text-sm font-semibold text-white">GPU Cluster</h2>
        <div className="flex items-center gap-2 text-xs text-slate-400 flex-wrap justify-end">
          <span>{onlineCount}/{nodeStatuses.length} nodes online</span>
          <span className="text-slate-700">·</span>
          <span>{flatGpus.length} GPU{flatGpus.length !== 1 ? "s" : ""}</span>
          <span className="text-slate-700">·</span>
          <span>{vramGB(usedVramMb)} / {vramGB(totalVramMb)} GB used</span>
        </div>
      </div>

      <div className="p-4 space-y-4">
        {nodeStatuses.length === 0 && (
          <p className="text-sm text-slate-500 text-center py-4">No nodes configured yet.</p>
        )}

        {/* Unified GPU grid — all nodes' GPUs together */}
        {flatGpus.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3">
            {flatGpus.map(({ nodeKey, node, ns, gpu }) => {
              const pct    = vramPct(gpu);
              const isOpen = expanded?.nodeKey === nodeKey && expanded?.gpuIndex === gpu.index;
              return (
                <div
                  key={`${nodeKey}:${gpu.index}`}
                  className={`bg-slate-900/60 border rounded-xl p-3 space-y-2.5 cursor-pointer transition-colors ${
                    isOpen ? "border-blue-500/60" : "border-border hover:border-slate-600"
                  }`}
                  onClick={() => setExpanded(isOpen ? null : { nodeKey, gpuIndex: gpu.index })}
                >
                  {/* Top row: GPU index + node badge */}
                  <div className="flex items-center justify-between gap-1">
                    <div className="flex items-center gap-1 min-w-0">
                      <span className="text-xs font-semibold text-slate-400 uppercase tracking-widest flex-shrink-0">GPU {gpu.index}</span>
                      {gpu.unified_memory && (
                        <span className="text-xs px-1 py-0.5 rounded bg-violet-900/40 text-violet-300 leading-none flex-shrink-0" title="Unified memory — VRAM shares system RAM">uni</span>
                      )}
                    </div>
                    <span className="text-xs px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 truncate max-w-[60px]" title={node.name}>{node.name}</span>
                  </div>

                  {/* Temp + util */}
                  <div className="flex items-center justify-between">
                    {gpu.temperature_c != null
                      ? <span className={`text-xs font-medium ${tempColor(gpu.temperature_c)}`}>{gpu.temperature_c}°C</span>
                      : <span />
                    }
                    <div className="flex items-center gap-1">
                      <span className="text-xs text-slate-500">{gpu.utilization_pct}%</span>
                      <span className="text-slate-600 text-xs">{isOpen ? "▲" : "▼"}</span>
                    </div>
                  </div>

                  <p className="text-xs font-medium text-white leading-tight truncate" title={gpu.name}>{gpu.name}</p>

                  {/* VRAM bar */}
                  <div>
                    <div className="flex justify-between text-xs text-slate-400 mb-1">
                      <span>{vramGB(gpu.vram_used_mb)} GB</span>
                      <span>{vramGB(gpu.vram_total_mb)} GB{gpu.unified_memory ? "*" : ""}</span>
                    </div>
                    <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden">
                      <div className={`h-full rounded-full transition-all ${barColor(pct)}`} style={{ width: `${pct}%` }} />
                    </div>
                  </div>

                  {/* Processes */}
                  {gpu.processes && gpu.processes.length > 0 ? (
                    <div className="space-y-1">
                      {gpu.processes.map((proc) => {
                        const vllmInst = proc.label.startsWith("vllm")
                          ? ns.status!.instances.find(i => i.gpu_index === gpu.index)
                          : undefined;
                        return (
                          <div key={proc.pid} className="flex items-center gap-1.5 text-xs bg-slate-800 rounded px-2 py-1" onClick={e => e.stopPropagation()}>
                            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                              vllmInst
                                ? vllmInst.status === "healthy" ? "bg-emerald-400" : "bg-amber-400 animate-pulse"
                                : "bg-slate-500"
                            }`} />
                            <span className="text-slate-300 truncate flex-1 min-w-0">{proc.label}</span>
                            <span className="text-slate-500 flex-shrink-0">{vramGB(proc.vram_used_mb)}G</span>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="text-xs text-slate-600 italic">idle</p>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Expanded detail panel */}
        {expandedEntry && (() => {
          const { node, gpu } = expandedEntry;
          const memPct     = vramPct(gpu);
          const powerPct   = gpu.power_limit_w ? (gpu.power_draw_w ?? 0) / gpu.power_limit_w * 100 : 0;
          const powerColor = powerPct > 95 ? "bg-red-500" : powerPct > 80 ? "bg-amber-400" : "bg-emerald-500";
          return (
            <div className="bg-slate-900/70 border border-blue-500/30 rounded-xl px-4 py-4 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold text-white">{gpu.name}</p>
                  <p className="text-xs text-slate-500 font-mono mt-0.5">{node.name} · GPU {gpu.index}</p>
                </div>
                <button onClick={() => setExpanded(null)} className="text-slate-500 hover:text-white text-lg leading-none">✕</button>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                <StatBox label="Temperature" value={gpu.temperature_c != null ? `${gpu.temperature_c}°C` : "—"} valueClass={gpu.temperature_c != null ? tempColor(gpu.temperature_c) : "text-slate-500"} />
                <StatBox label="Fan Speed" value={gpu.fan_speed_pct != null ? `${Math.round(gpu.fan_speed_pct)}%` : "—"} sub={gpu.fan_speed_pct != null ? "active cooling" : "passive / N/A"} bar={gpu.fan_speed_pct != null ? { pct: gpu.fan_speed_pct, color: "bg-blue-400" } : undefined} />
                <StatBox label="GPU Load" value={`${gpu.utilization_pct}%`} bar={{ pct: gpu.utilization_pct, color: barColor(gpu.utilization_pct) }} />
                <StatBox label={gpu.unified_memory ? "Memory (shared RAM)" : "Memory"} value={`${memPct}%`} sub={`${vramGB(gpu.vram_used_mb)} / ${vramGB(gpu.vram_total_mb)} GB`} bar={{ pct: memPct, color: barColor(memPct) }} />
                <StatBox label="Clock Speed" value={gpu.clock_mhz != null ? `${fmt(gpu.clock_mhz)} MHz` : "—"} />
                <StatBox label="Power Draw" value={gpu.power_draw_w != null ? `${gpu.power_draw_w.toFixed(1)} W` : "—"} sub={gpu.power_limit_w != null ? `limit ${gpu.power_limit_w.toFixed(0)} W` : undefined} bar={gpu.power_draw_w != null && gpu.power_limit_w != null ? { pct: powerPct, color: powerColor } : undefined} />
              </div>
            </div>
          );
        })()}

        {/* Offline nodes */}
        {offlineNodes.length > 0 && (
          <div className="space-y-2">
            {offlineNodes.map((ns) => {
              const nodeKey = `${ns.node.ip}:${ns.node.agent_port}`;
              return (
                <div key={nodeKey} className="bg-red-900/10 border border-red-900/30 rounded-lg px-3 py-2.5 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-red-500 flex-shrink-0" />
                    <span className="text-sm font-medium text-white">{ns.node.name}</span>
                    <span className="text-xs text-slate-500 font-mono">{ns.node.ip}:{ns.node.agent_port}</span>
                    <span className="text-xs text-red-400 ml-auto">unreachable</span>
                  </div>
                  {ns.node.setup_cmd && (
                    <>
                      <p className="text-xs text-slate-500">Run this on <span className="text-white">{ns.node.name}</span> to bring it online:</p>
                      <pre className="text-xs bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-emerald-300 font-mono whitespace-pre-wrap break-all select-all">
                        {ns.node.setup_cmd}
                      </pre>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
