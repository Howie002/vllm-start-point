"use client";

import { useState } from "react";
import type { ModelEntry, VLLMInstance, ClusterGPU, PendingLaunch } from "@/lib/types";
import { createNodeApi } from "@/lib/api";

interface Props {
  model: ModelEntry;
  clusterGpus: ClusterGPU[];
  allInstances: VLLMInstance[];
  onClose: () => void;
  onLaunched: () => void;
  // Fire-and-forget hook the modal calls the moment a launch returns
  // successfully. Lets the dashboard render an optimistic "Loading…" banner
  // on the targeted GPUs immediately, instead of waiting for the next
  // /status poll (up to 15s away) to surface the new vLLM process.
  onLaunchStart: (p: PendingLaunch) => void;
}

function nextPort(instances: VLLMInstance[]) {
  const used = new Set(instances.map(i => i.port));
  for (let p = 8020; p < 8100; p++) { if (!used.has(p)) return p; }
  return 8020;
}

function kvMbPerToken(sizeB: number) {
  if (sizeB <= 2)  return 0.05;
  if (sizeB <= 10) return 0.125;
  if (sizeB <= 20) return 0.20;
  if (sizeB <= 50) return 0.25;
  return 0.31;
}

interface VramBreakdown {
  totalGB: number; reservedGB: number; weightsGB: number;
  kvPoolGB: number; freeGB: number;
  seqKvGB: number | null; concurrentSeqs: number | null; overLimit: boolean;
}

function vramBreakdown(
  selected: ClusterGPU[], utilPct: number, weightsGB: number,
  sizeB: number, maxModelLen: number | "",
): VramBreakdown {
  const totalGB    = selected.reduce((s, cg) => s + cg.gpu.vram_total_mb / 1024, 0);
  const reservedGB = totalGB * (utilPct / 100);
  const kvPoolGB   = Math.max(0, reservedGB - weightsGB);
  const freeGB     = Math.max(0, totalGB - reservedGB);
  const ctx        = typeof maxModelLen === "number" && maxModelLen > 0 ? maxModelLen : null;
  const seqKvGB    = ctx ? (ctx * kvMbPerToken(sizeB)) / 1024 : null;
  const concurrentSeqs = seqKvGB && seqKvGB > 0 ? Math.floor(kvPoolGB / seqKvGB) : null;
  return { totalGB, reservedGB, weightsGB, kvPoolGB, freeGB, seqKvGB, concurrentSeqs, overLimit: weightsGB > reservedGB };
}

export function DeployModal({ model, clusterGpus, allInstances, onClose, onLaunched, onLaunchStart }: Props) {
  const [selectedGpus, setSelectedGpus] = useState<ClusterGPU[]>(
    clusterGpus.length > 0 ? [clusterGpus[0]] : []
  );
  const [port, setPort]               = useState(nextPort(allInstances));
  const [servedName, setServedName]   = useState(
    model.id.split("/").pop()?.toLowerCase().replace(/[^a-z0-9-]/g, "-") ?? "model"
  );
  const [gpuMemUtil, setGpuMemUtil]   = useState(85);
  const [maxModelLen, setMaxModelLen] = useState<number | "">(
    (model.flags.max_model_len as number) ?? model.max_context ?? ""
  );
  const [maxNumSeqs, setMaxNumSeqs]   = useState<number | "">(256);
  const [registerProxy, setRegisterProxy] = useState(true);
  const [launching, setLaunching]     = useState(false);
  const [error, setError]             = useState<string | null>(null);
  // Structured failure (HTTP 422 from agent) — set when vLLM exited during
  // startup before binding the port. log_tail lets the user see the actual
  // stderr without opening LaunchLogModal.
  const [launchFailure, setLaunchFailure] = useState<{
    message: string;
    exit_code: number | null;
    log_tail: string[];
    log_path: string;
    auto_retry?: { reason: string; max_num_batched_tokens: number; result: string };
  } | null>(null);

  const targetNode = selectedGpus[0]?.node ?? null;

  // Group GPUs by node for the picker
  const gpusByNode = clusterGpus.reduce<Record<string, ClusterGPU[]>>((acc, cg) => {
    const key = `${cg.node.ip}:${cg.node.agent_port}`;
    if (!acc[key]) acc[key] = [];
    acc[key].push(cg);
    return acc;
  }, {});

  function isSelected(cg: ClusterGPU) {
    return selectedGpus.some(s => s.node.ip === cg.node.ip && s.gpu.index === cg.gpu.index);
  }

  function toggleGpu(cg: ClusterGPU) {
    setSelectedGpus(prev => {
      if (isSelected(cg)) {
        const next = prev.filter(s => !(s.node.ip === cg.node.ip && s.gpu.index === cg.gpu.index));
        return next.length === 0 ? prev : next; // must keep at least one
      }
      // Switching nodes: reset selection to just this GPU
      if (prev.length > 0 && prev[0].node.ip !== cg.node.ip) return [cg];
      return [...prev, cg];
    });
  }

  async function handleLaunch() {
    if (!targetNode || selectedGpus.length === 0) { setError("Select at least one GPU."); return; }
    setLaunching(true); setError(null); setLaunchFailure(null);
    try {
      const extraFlags = {
        ...model.flags,
        gpu_memory_utilization: (gpuMemUtil / 100).toFixed(2),
        ...(maxModelLen ? { max_model_len: maxModelLen } : {}),
        ...(maxNumSeqs   ? { max_num_seqs: maxNumSeqs }   : {}),
      };
      await createNodeApi(targetNode).launch({
        model_id: model.id,
        gpu_indices: selectedGpus.map(cg => cg.gpu.index),
        port, served_name: servedName,
        register_with_proxy: registerProxy,
        extra_flags: extraFlags,
      });
      onLaunchStart({
        nodeIp: targetNode.ip,
        nodeAgentPort: targetNode.agent_port,
        gpuIndices: selectedGpus.map(cg => cg.gpu.index),
        modelId: model.id,
        modelName: model.name,
        servedName,
        startedAt: Date.now(),
      });
      onLaunched(); onClose();
    } catch (e) {
      // The agent returns HTTP 422 with a JSON body like
      // { detail: { message, exit_code, log_tail, log_path, auto_retry? } }
      // when vLLM crashes during startup. Try to parse that out so we can
      // render the stderr tail; fall back to the raw error string otherwise.
      const raw = e instanceof Error ? e.message : String(e);
      try {
        const parsed = JSON.parse(raw);
        const detail = parsed?.detail;
        if (detail && typeof detail === "object" && Array.isArray(detail.log_tail)) {
          setLaunchFailure({
            message: detail.message ?? "Launch failed.",
            exit_code: detail.exit_code ?? null,
            log_tail: detail.log_tail,
            log_path: detail.log_path ?? "",
            auto_retry: detail.auto_retry,
          });
          setLaunching(false);
          return;
        }
        if (detail && typeof detail === "string") {
          setError(detail); setLaunching(false); return;
        }
      } catch {
        // not JSON — fall through
      }
      setError(raw); setLaunching(false);
    }
  }

  const vram = vramBreakdown(selectedGpus, gpuMemUtil, model.vram_gb, model.size_b, maxModelLen);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-card border border-border rounded-2xl w-full max-w-lg mx-4 shadow-2xl overflow-y-auto max-h-[90vh]">
        {/* Header */}
        <div className="px-6 py-4 border-b border-border flex items-start justify-between">
          <div>
            <h2 className="text-white font-semibold">{model.name}</h2>
            <p className="text-xs text-slate-500 font-mono mt-0.5">{model.id}</p>
            {targetNode && (
              <p className="text-xs text-blue-400 mt-0.5">→ {targetNode.name} ({targetNode.ip})</p>
            )}
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white text-lg leading-none ml-4">✕</button>
        </div>

        <div className="px-6 py-4 space-y-5">

          {/* GPU selector — grouped by node */}
          <div>
            <label className="text-xs text-slate-400 font-medium uppercase tracking-wider mb-2 block">GPU(s)</label>
            <div className="space-y-3">
              {Object.entries(gpusByNode).map(([nodeKey, nodeGpus]) => {
                const nodeName = nodeGpus[0].node.name;
                const isTargetNode = targetNode && `${targetNode.ip}:${targetNode.agent_port}` === nodeKey;
                const dimmed = targetNode && !isTargetNode;
                return (
                  <div key={nodeKey} className={`space-y-1.5 transition-opacity ${dimmed ? "opacity-40" : ""}`}>
                    <p className="text-xs text-slate-500">{nodeName}</p>
                    <div className="grid grid-cols-4 gap-2">
                      {nodeGpus.map(cg => {
                        const sel = isSelected(cg);
                        return (
                          <button
                            key={cg.gpu.index}
                            onClick={() => toggleGpu(cg)}
                            className={`rounded-lg border p-2 text-center text-xs transition-colors ${
                              sel
                                ? "border-blue-500 bg-blue-900/30 text-blue-300"
                                : "border-border text-slate-400 hover:border-slate-500"
                            }`}
                          >
                            <div className="font-semibold">GPU {cg.gpu.index}</div>
                            <div className="text-slate-500 mt-0.5">{Math.round(cg.gpu.vram_free_mb / 1024)}GB free</div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
            {clusterGpus.length === 0 && (
              <p className="text-xs text-slate-500 text-center py-4">No online nodes with GPUs available.</p>
            )}
          </div>

          {/* GPU memory utilization slider */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs text-slate-400 font-medium uppercase tracking-wider">GPU memory reservation</label>
              <span className="text-sm font-semibold text-white">{gpuMemUtil}%</span>
            </div>
            <input type="range" min={20} max={95} step={5} value={gpuMemUtil}
              onChange={e => setGpuMemUtil(Number(e.target.value))} className="w-full accent-blue-500" />
            <div className="flex justify-between text-xs text-slate-500 mt-1">
              <span>20% — minimal</span><span>95% — maximum</span>
            </div>

            {/* VRAM breakdown */}
            <div className="mt-3 bg-slate-900/60 border border-border rounded-lg p-3 space-y-2">
              {vram.totalGB > 0 && (
                <div className="h-2.5 rounded-full overflow-hidden flex gap-px bg-slate-700">
                  <div className="h-full bg-blue-500 rounded-l-full flex-shrink-0"
                    style={{ width: `${Math.min((vram.weightsGB / vram.totalGB) * 100, 100)}%` }}
                    title={`Model weights: ${vram.weightsGB} GB`} />
                  <div className={`h-full flex-shrink-0 ${vram.overLimit ? "bg-red-500" : "bg-emerald-500"}`}
                    style={{ width: `${Math.max(0, (vram.kvPoolGB / vram.totalGB) * 100)}%` }}
                    title={`KV cache pool: ${vram.kvPoolGB.toFixed(1)} GB`} />
                </div>
              )}
              <div className="grid grid-cols-3 gap-1 text-xs">
                <div>
                  <p className="text-slate-500">Weights</p>
                  <p className="text-blue-400 font-medium">{vram.weightsGB} GB</p>
                  <p className="text-slate-600">fixed</p>
                </div>
                <div>
                  <p className="text-slate-500">KV cache pool</p>
                  <p className={`font-medium ${vram.overLimit ? "text-red-400" : "text-emerald-400"}`}>
                    {vram.overLimit ? "—" : `${vram.kvPoolGB.toFixed(1)} GB`}
                  </p>
                  <p className="text-slate-600">{vram.reservedGB.toFixed(1)} GB reserved</p>
                </div>
                <div>
                  <p className="text-slate-500">Left for others</p>
                  <p className="text-slate-300 font-medium">{vram.freeGB.toFixed(1)} GB</p>
                  <p className="text-slate-600">on selected GPU{selectedGpus.length > 1 ? "s" : ""}</p>
                </div>
              </div>
              {vram.overLimit && (
                <p className="text-xs text-red-400">
                  Model weights ({vram.weightsGB} GB) exceed reservation ({vram.reservedGB.toFixed(1)} GB) — increase the slider.
                </p>
              )}
              {selectedGpus.some(cg => cg.gpu.unified_memory) && (
                <p className="text-xs text-violet-400 mt-1">
                  Unified memory GPU — VRAM figure reflects shared system RAM. Model weights and KV cache compete with the OS and other processes.
                </p>
              )}
            </div>
          </div>

          {/* Port / served name */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-slate-400 font-medium uppercase tracking-wider mb-1 block">Port</label>
              <input type="number" value={port} onChange={e => setPort(Number(e.target.value))}
                className="w-full bg-slate-800 border border-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
            </div>
            <div>
              <label className="text-xs text-slate-400 font-medium uppercase tracking-wider mb-1 block">Served name</label>
              <input type="text" value={servedName} onChange={e => setServedName(e.target.value)}
                className="w-full bg-slate-800 border border-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
            </div>
          </div>

          {/* Context length / parallel slots */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs text-slate-400 font-medium uppercase tracking-wider">Max context</label>
                <span className="text-xs text-slate-500">native max: <span className="text-slate-300">{model.max_context.toLocaleString()}</span></span>
              </div>
              <input type="number" value={maxModelLen} min={512} max={model.max_context}
                placeholder={model.max_context.toString()}
                onChange={e => setMaxModelLen(e.target.value ? Math.min(Number(e.target.value), model.max_context) : "")}
                className="w-full bg-slate-800 border border-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 placeholder-slate-600" />
              <div className="flex justify-between text-xs mt-1">
                <span className="text-slate-500">Lower = more concurrent seqs</span>
                {vram.concurrentSeqs != null && (
                  <span className={vram.concurrentSeqs < 1 ? "text-red-400" : vram.concurrentSeqs < 4 ? "text-amber-400" : "text-emerald-400"}>
                    ~{vram.concurrentSeqs} seq{vram.concurrentSeqs !== 1 ? "s" : ""} in KV cache
                  </span>
                )}
              </div>
            </div>
            <div>
              <label className="text-xs text-slate-400 font-medium uppercase tracking-wider mb-1 block">Max parallel slots</label>
              <input type="number" value={maxNumSeqs} placeholder="256"
                onChange={e => setMaxNumSeqs(e.target.value ? Number(e.target.value) : "")}
                className="w-full bg-slate-800 border border-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 placeholder-slate-600" />
              <p className="text-xs text-slate-500 mt-1">max concurrent requests (<code>--max-num-seqs</code>)</p>
            </div>
          </div>

          <label className="flex items-center gap-3 cursor-pointer">
            <input type="checkbox" checked={registerProxy} onChange={e => setRegisterProxy(e.target.checked)} className="w-4 h-4 accent-blue-500" />
            <span className="text-sm text-slate-300">Register with LiteLLM proxy</span>
          </label>

          {/* Model info */}
          <div className="bg-slate-800/50 rounded-lg p-3 text-xs text-slate-400 space-y-1">
            <div className="flex justify-between"><span>Quantization</span><span className="text-slate-300">{model.quantization}</span></div>
            <div className="flex justify-between"><span>Model weights</span><span className="text-slate-300">{model.vram_gb} GB</span></div>
            <div className="flex justify-between">
              <span>Cached locally</span>
              <span className={model.cached ? "text-emerald-400" : "text-slate-500"}>{model.cached ? "Yes" : "No — will download on launch"}</span>
            </div>
            {vram.concurrentSeqs != null && (
              <div className="flex justify-between pt-0.5 border-t border-slate-700/50 mt-1">
                <span>Est. concurrent sequences</span>
                <span className={vram.concurrentSeqs < 1 ? "text-red-400" : vram.concurrentSeqs < 4 ? "text-amber-400" : "text-emerald-400"}>
                  ~{vram.concurrentSeqs}
                </span>
              </div>
            )}
          </div>

          {error && <p className="text-xs text-red-400 bg-red-900/20 border border-red-800 rounded-lg px-3 py-2">{error}</p>}

          {launchFailure && (
            <div className="text-xs bg-red-900/20 border border-red-800 rounded-lg overflow-hidden">
              <div className="px-3 py-2 border-b border-red-800/60">
                <p className="text-red-300 font-medium">vLLM crashed during startup</p>
                <p className="text-red-400/80 mt-0.5">{launchFailure.message}</p>
                {launchFailure.auto_retry && (
                  <p className="text-amber-300/90 mt-1.5">
                    Auto-retry with <code>--max-num-batched-tokens={launchFailure.auto_retry.max_num_batched_tokens}</code> ({launchFailure.auto_retry.reason}):{" "}
                    <span className={launchFailure.auto_retry.result === "ok" ? "text-emerald-300" : "text-red-300"}>
                      {launchFailure.auto_retry.result}
                    </span>
                  </p>
                )}
                <p className="text-red-500/60 font-mono mt-1">
                  {launchFailure.log_path}
                </p>
              </div>
              <pre className="bg-slate-950 text-slate-300 p-3 max-h-56 overflow-auto font-mono text-[11px] whitespace-pre-wrap break-all">
                {launchFailure.log_tail.join("\n")}
              </pre>
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-border flex gap-3 justify-end">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-400 hover:text-white transition-colors">Cancel</button>
          <button
            onClick={handleLaunch}
            disabled={launching || selectedGpus.length === 0 || !targetNode}
            className="px-5 py-2 text-sm rounded-xl bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50 transition-colors font-medium"
          >
            {launching ? "Launching…" : `Launch on ${targetNode?.name ?? "—"}`}
          </button>
        </div>
      </div>
    </div>
  );
}
