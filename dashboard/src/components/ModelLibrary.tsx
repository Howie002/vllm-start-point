"use client";

import { useState } from "react";
import type { ModelEntry, GPU, VLLMInstance, NodeConfig } from "@/lib/types";
import { DeployModal } from "./DeployModal";

const TYPE_COLORS: Record<string, string> = {
  chat:      "bg-blue-900/40 text-blue-300",
  reasoning: "bg-purple-900/40 text-purple-300",
  embedding: "bg-teal-900/40 text-teal-300",
};

const FAMILIES = ["all", "nemotron", "llama", "qwen", "mistral", "deepseek", "phi", "gemma", "bert"];

interface Props {
  models: ModelEntry[];
  gpus: GPU[];
  instances: VLLMInstance[];
  node: NodeConfig;
  onRefresh: () => void;
}

export function ModelLibrary({ models, gpus, instances, node, onRefresh }: Props) {
  const [family, setFamily]       = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [deploying, setDeploying]  = useState<ModelEntry | null>(null);

  const runningIds = new Set(instances.map((i) => i.model_id));

  const filtered = models.filter((m) => {
    if (family !== "all" && m.family !== family) return false;
    if (typeFilter !== "all" && m.type !== typeFilter) return false;
    return true;
  });

  return (
    <>
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex flex-wrap items-center gap-3">
          <h3 className="text-sm font-semibold text-white">Model Library</h3>

          <div className="flex gap-1 flex-wrap ml-auto">
            {["all", "chat", "reasoning", "embedding"].map((t) => (
              <button
                key={t}
                onClick={() => setTypeFilter(t)}
                className={`text-xs px-2.5 py-1 rounded-full transition-colors ${
                  typeFilter === t ? "bg-slate-600 text-white" : "text-slate-400 hover:text-white"
                }`}
              >
                {t}
              </button>
            ))}
          </div>

          <div className="flex gap-1 flex-wrap">
            {FAMILIES.map((f) => (
              <button
                key={f}
                onClick={() => setFamily(f)}
                className={`text-xs px-2.5 py-1 rounded-full transition-colors ${
                  family === f ? "bg-slate-600 text-white" : "text-slate-400 hover:text-white"
                }`}
              >
                {f}
              </button>
            ))}
          </div>
        </div>

        <div className="divide-y divide-border">
          {filtered.map((model) => {
            const isRunning = runningIds.has(model.id);
            return (
              <div
                key={model.id}
                className="px-4 py-3 flex items-center gap-4 hover:bg-slate-800/30 transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-white">{model.name}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${TYPE_COLORS[model.type] ?? "bg-slate-700 text-slate-300"}`}>
                      {model.type}
                    </span>
                    {model.cached && (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-900/30 text-emerald-400">cached</span>
                    )}
                    {isRunning && (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-blue-900/30 text-blue-300">running</span>
                    )}
                  </div>
                  <p className="text-xs text-slate-500 mt-0.5 font-mono truncate">{model.id}</p>
                  <p className="text-xs text-slate-400 mt-1 leading-relaxed">{model.description}</p>
                </div>

                <div className="text-right flex-shrink-0 space-y-1">
                  <p className="text-xs text-slate-400">{model.vram_gb} GB</p>
                  <p className="text-xs text-slate-500">{model.size_b}B params</p>
                  <button
                    onClick={() => setDeploying(model)}
                    className="mt-1 text-xs px-3 py-1.5 rounded-lg bg-blue-700 hover:bg-blue-600 text-white transition-colors"
                  >
                    Deploy
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {deploying && (
        <DeployModal
          model={deploying}
          node={node}
          gpus={gpus}
          instances={instances}
          onClose={() => setDeploying(null)}
          onLaunched={() => {
            setDeploying(null);
            onRefresh();
          }}
        />
      )}
    </>
  );
}
