"use client";

import { useState } from "react";
import type { ModelEntry, GPU, VLLMInstance, NodeConfig } from "@/lib/types";
import { createNodeApi } from "@/lib/api";

interface Props {
  model: ModelEntry;
  node: NodeConfig;
  gpus: GPU[];
  instances: VLLMInstance[];
  onClose: () => void;
  onLaunched: () => void;
}

function nextPort(instances: VLLMInstance[]) {
  const used = new Set(instances.map((i) => i.port));
  for (let p = 8020; p < 8100; p++) {
    if (!used.has(p)) return p;
  }
  return 8020;
}

// Estimated KV cache MB per token based on typical GQA Transformer architectures
function kvMbPerToken(sizeB: number): number {
  if (sizeB <= 2)  return 0.05;
  if (sizeB <= 10) return 0.125;
  if (sizeB <= 20) return 0.20;
  if (sizeB <= 50) return 0.25;
  return 0.31;
}

interface VramBreakdown {
  totalGB:      number;   // total GPU VRAM (selected GPUs)
  reservedGB:   number;   // gpu_memory_utilization × totalGB
  weightsGB:    number;   // model weights (fixed)
  kvPoolGB:     number;   // reservedGB − weightsGB
  freeGB:       number;   // totalGB − reservedGB (other processes)
  seqKvGB:      number | null;   // KV cost of one full sequence
  concurrentSeqs: number | null; // estimated concurrent seqs in pool
  overLimit:    boolean;  // weights alone exceed reservation
}

function vramBreakdown(
  gpus: GPU[],
  selectedGPUs: number[],
  utilPct: number,
  weightsGB: number,
  sizeB: number,
  maxModelLen: number | "",
): VramBreakdown {
  const totalGB = selectedGPUs.reduce((sum, idx) => {
    const g = gpus.find((g) => g.index === idx);
    return sum + (g ? g.vram_total_mb / 1024 : 0);
  }, 0);
  const reservedGB = totalGB * (utilPct / 100);
  const kvPoolGB   = Math.max(0, reservedGB - weightsGB);
  const freeGB     = Math.max(0, totalGB - reservedGB);
  const ctx        = typeof maxModelLen === "number" && maxModelLen > 0 ? maxModelLen : null;
  const seqKvGB    = ctx ? (ctx * kvMbPerToken(sizeB)) / 1024 : null;
  const concurrentSeqs = seqKvGB && seqKvGB > 0 ? Math.floor(kvPoolGB / seqKvGB) : null;
  return {
    totalGB, reservedGB, weightsGB, kvPoolGB, freeGB,
    seqKvGB, concurrentSeqs,
    overLimit: weightsGB > reservedGB,
  };
}

export function DeployModal({ model, node, gpus, instances, onClose, onLaunched }: Props) {
  const defaultGPU = gpus[0]?.index ?? 0;
  const [selectedGPUs, setSelectedGPUs]     = useState<number[]>([defaultGPU]);
  const [port, setPort]                     = useState(nextPort(instances));
  const [servedName, setServedName]         = useState(
    model.id.split("/").pop()?.toLowerCase().replace(/[^a-z0-9-]/g, "-") ?? "model"
  );
  const [gpuMemUtil, setGpuMemUtil]         = useState(85);
  const [maxModelLen, setMaxModelLen]       = useState<number | "">(
    (model.flags.max_model_len as number) ?? model.max_context ?? ""
  );
  const [maxNumSeqs, setMaxNumSeqs]         = useState<number | "">(256);
  const [registerProxy, setRegisterProxy]   = useState(true);
  const [launching, setLaunching]           = useState(false);
  const [error, setError]                   = useState<string | null>(null);

  function toggleGPU(idx: number) {
    setSelectedGPUs((prev) =>
      prev.includes(idx) ? prev.filter((g) => g !== idx) : [...prev, idx]
    );
  }

  async function handleLaunch() {
    if (selectedGPUs.length === 0) { setError("Select at least one GPU."); return; }
    setLaunching(true);
    setError(null);
    try {
      const api = createNodeApi(node);
      const extraFlags = {
        ...model.flags,
        gpu_memory_utilization: (gpuMemUtil / 100).toFixed(2),
        ...(maxModelLen ? { max_model_len: maxModelLen } : {}),
        ...(maxNumSeqs   ? { max_num_seqs: maxNumSeqs }   : {}),
      };
      await api.launch({
        model_id: model.id,
        gpu_indices: selectedGPUs,
        port,
        served_name: servedName,
        register_with_proxy: registerProxy,
        extra_flags: extraFlags,
      });
      onLaunched();
      onClose();
    } catch (e) {
      setError(String(e));
      setLaunching(false);
    }
  }

  const vram = vramBreakdown(gpus, selectedGPUs, gpuMemUtil, model.vram_gb, model.size_b, maxModelLen);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-card border border-border rounded-2xl w-full max-w-lg mx-4 shadow-2xl overflow-y-auto max-h-[90vh]">
        <div className="px-6 py-4 border-b border-border flex items-start justify-between">
          <div>
            <h2 className="text-white font-semibold">{model.name}</h2>
            <p className="text-xs text-slate-500 font-mono mt-0.5">{model.id}</p>
            <p className="text-xs text-blue-400 mt-0.5">→ {node.name} ({node.ip})</p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white text-lg leading-none ml-4">✕</button>
        </div>

        <div className="px-6 py-4 space-y-5">

          {/* GPU selector */}
          <div>
            <label className="text-xs text-slate-400 font-medium uppercase tracking-wider mb-2 block">GPU(s)</label>
            <div className="grid grid-cols-4 gap-2">
              {gpus.map((gpu) => (
                <button
                  key={gpu.index}
                  onClick={() => toggleGPU(gpu.index)}
                  className={`rounded-lg border p-2 text-center text-xs transition-colors ${
                    selectedGPUs.includes(gpu.index)
                      ? "border-blue-500 bg-blue-900/30 text-blue-300"
                      : "border-border text-slate-400 hover:border-slate-500"
                  }`}
                >
                  <div className="font-semibold">GPU {gpu.index}</div>
                  <div className="text-slate-500 mt-0.5">{Math.round(gpu.vram_free_mb / 1024)}GB free</div>
                </button>
              ))}
            </div>
          </div>

          {/* GPU memory utilization slider */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs text-slate-400 font-medium uppercase tracking-wider">
                GPU memory reservation
              </label>
              <span className="text-sm font-semibold text-white">{gpuMemUtil}%</span>
            </div>
            <input
              type="range"
              min={20} max={95} step={5}
              value={gpuMemUtil}
              onChange={(e) => setGpuMemUtil(Number(e.target.value))}
              className="w-full accent-blue-500"
            />
            <div className="flex justify-between text-xs text-slate-500 mt-1">
              <span>20% — minimal</span>
              <span>95% — maximum</span>
            </div>

            {/* Live VRAM breakdown — updates with slider, GPU, and context length */}
            <div className="mt-3 bg-slate-900/60 border border-border rounded-lg p-3 space-y-2">

              {/* Stacked bar: weights | kv cache | free */}
              {vram.totalGB > 0 && (
                <div className="h-2.5 rounded-full overflow-hidden flex gap-px bg-slate-700">
                  <div
                    className="h-full bg-blue-500 rounded-l-full flex-shrink-0"
                    style={{ width: `${Math.min((vram.weightsGB / vram.totalGB) * 100, 100)}%` }}
                    title={`Model weights: ${vram.weightsGB} GB`}
                  />
                  <div
                    className={`h-full flex-shrink-0 ${vram.overLimit ? "bg-red-500" : "bg-emerald-500"}`}
                    style={{ width: `${Math.max(0, ((vram.kvPoolGB) / vram.totalGB) * 100)}%` }}
                    title={`KV cache pool: ${vram.kvPoolGB.toFixed(1)} GB`}
                  />
                </div>
              )}

              {/* Numbers */}
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
                  <p className="text-slate-600">{vram.reservedGB.toFixed(1)} GB total</p>
                </div>
                <div>
                  <p className="text-slate-500">Left for others</p>
                  <p className="text-slate-300 font-medium">{vram.freeGB.toFixed(1)} GB</p>
                  <p className="text-slate-600">on this GPU</p>
                </div>
              </div>

              {vram.overLimit && (
                <p className="text-xs text-red-400">
                  Model weights ({vram.weightsGB} GB) exceed reservation ({vram.reservedGB.toFixed(1)} GB) — increase the slider.
                </p>
              )}
            </div>
          </div>

          {/* Port / served name / max context */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-slate-400 font-medium uppercase tracking-wider mb-1 block">Port</label>
              <input
                type="number"
                value={port}
                onChange={(e) => setPort(Number(e.target.value))}
                className="w-full bg-slate-800 border border-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="text-xs text-slate-400 font-medium uppercase tracking-wider mb-1 block">Served name</label>
              <input
                type="text"
                value={servedName}
                onChange={(e) => setServedName(e.target.value)}
                className="w-full bg-slate-800 border border-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs text-slate-400 font-medium uppercase tracking-wider">
                  Max context length (tokens)
                </label>
                <span className="text-xs text-slate-500">
                  Native max: <span className="text-slate-300">{model.max_context.toLocaleString()}</span>
                </span>
              </div>
              <input
                type="number"
                value={maxModelLen}
                min={512}
                max={model.max_context}
                placeholder={model.max_context.toString()}
                onChange={(e) => setMaxModelLen(e.target.value ? Math.min(Number(e.target.value), model.max_context) : "")}
                className="w-full bg-slate-800 border border-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 placeholder-slate-600"
              />
              <div className="flex justify-between text-xs mt-1">
                <span className="text-slate-500">Lower = more concurrent requests fit</span>
                {vram.concurrentSeqs != null && (
                  <span className={vram.concurrentSeqs < 1 ? "text-red-400" : vram.concurrentSeqs < 4 ? "text-amber-400" : "text-emerald-400"}>
                    ~{vram.concurrentSeqs} full seq{vram.concurrentSeqs !== 1 ? "s" : ""} in KV cache
                  </span>
                )}
              </div>
            </div>
            <div>
              <label className="text-xs text-slate-400 font-medium uppercase tracking-wider mb-1 block">
                Max parallel slots
              </label>
              <input
                type="number"
                value={maxNumSeqs}
                placeholder="256"
                onChange={(e) => setMaxNumSeqs(e.target.value ? Number(e.target.value) : "")}
                className="w-full bg-slate-800 border border-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 placeholder-slate-600"
              />
              <p className="text-xs text-slate-500 mt-1">
                Max concurrent requests in-flight (<code>--max-num-seqs</code>).
              </p>
            </div>
          </div>

          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={registerProxy}
              onChange={(e) => setRegisterProxy(e.target.checked)}
              className="w-4 h-4 accent-blue-500"
            />
            <span className="text-sm text-slate-300">Register with LiteLLM proxy</span>
          </label>

          {/* Model info */}
          <div className="bg-slate-800/50 rounded-lg p-3 text-xs text-slate-400 space-y-1">
            <div className="flex justify-between">
              <span>Quantization</span>
              <span className="text-slate-300">{model.quantization}</span>
            </div>
            <div className="flex justify-between">
              <span>Model weights</span>
              <span className="text-slate-300">{model.vram_gb} GB</span>
            </div>
            <div className="flex justify-between">
              <span>Cached locally</span>
              <span className={model.cached ? "text-emerald-400" : "text-slate-500"}>
                {model.cached ? "Yes" : "No — will download on launch"}
              </span>
            </div>
            {vram.concurrentSeqs != null && (
              <div className="flex justify-between pt-0.5 border-t border-slate-700/50 mt-1">
                <span>Est. concurrent sequences</span>
                <span className={vram.concurrentSeqs < 1 ? "text-red-400" : vram.concurrentSeqs < 4 ? "text-amber-400" : "text-emerald-400"}>
                  ~{vram.concurrentSeqs} at {typeof maxModelLen === "number" ? (maxModelLen >= 1000 ? `${(maxModelLen/1000).toFixed(0)}K` : maxModelLen) : "—"} tokens
                </span>
              </div>
            )}
          </div>

          {error && (
            <p className="text-xs text-red-400 bg-red-900/20 border border-red-800 rounded-lg px-3 py-2">{error}</p>
          )}
        </div>

        <div className="px-6 py-4 border-t border-border flex gap-3 justify-end">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-300 hover:text-white transition-colors">
            Cancel
          </button>
          <button
            onClick={handleLaunch}
            disabled={launching}
            className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50 transition-colors"
          >
            {launching ? "Launching…" : "Launch"}
          </button>
        </div>
      </div>
    </div>
  );
}
