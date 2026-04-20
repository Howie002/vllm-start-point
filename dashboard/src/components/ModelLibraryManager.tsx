"use client";

import { useState, useEffect, useCallback } from "react";
import type { ModelEntry, NodeConfig } from "@/lib/types";
import { createNodeApi } from "@/lib/api";

const TYPE_COLORS: Record<string, string> = {
  chat:      "bg-blue-900/40 text-blue-300",
  reasoning: "bg-purple-900/40 text-purple-300",
  embedding: "bg-teal-900/40 text-teal-300",
};

const BLANK_FORM = {
  id: "", name: "", family: "", type: "chat" as ModelEntry["type"],
  size_b: "" as number | "", vram_gb: "" as number | "",
  min_gpus: 1, quantization: "bf16", max_context: "" as number | "",
  description: "", flags_raw: "{}",
};

interface Props {
  node: NodeConfig;
  onClose: () => void;
  onChanged: () => void;
}

export function ModelLibraryManager({ node, onClose, onChanged }: Props) {
  const [models, setModels]   = useState<ModelEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm]       = useState({ ...BLANK_FORM });
  const [saving, setSaving]   = useState(false);
  const [filter, setFilter]   = useState<"all" | "chat" | "reasoning" | "embedding">("all");

  const api = createNodeApi(node);

  const refresh = useCallback(async () => {
    try {
      const data = await api.libraryAll();
      setModels(data);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [node]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { refresh(); }, [refresh]);

  async function toggle(model: ModelEntry) {
    try {
      await api.toggleModel(model.id, !model.enabled);
      setModels((prev) => prev.map((m) => m.id === model.id ? { ...m, enabled: !m.enabled } : m));
      onChanged();
    } catch (e) {
      setError(String(e));
    }
  }

  async function remove(model: ModelEntry) {
    if (!confirm(`Remove "${model.name}" from the library?`)) return;
    try {
      await api.deleteModel(model.id);
      setModels((prev) => prev.filter((m) => m.id !== model.id));
      onChanged();
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      let flags: Record<string, unknown> = {};
      try { flags = JSON.parse(form.flags_raw); } catch { throw new Error("Extra flags is not valid JSON"); }
      const entry = {
        id:           form.id.trim(),
        name:         form.name.trim() || form.id.split("/").pop() || form.id,
        family:       form.family.trim() || "unknown",
        type:         form.type,
        size_b:       Number(form.size_b) || 0,
        vram_gb:      Number(form.vram_gb) || 0,
        min_gpus:     form.min_gpus,
        quantization: form.quantization || "bf16",
        max_context:  Number(form.max_context) || 32768,
        description:  form.description.trim(),
        flags,
        enabled:      true,
      };
      const added = await api.addModel(entry);
      setModels((prev) => [...prev, { ...added, cached: false }]);
      setForm({ ...BLANK_FORM });
      setShowAdd(false);
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  const visible = models.filter((m) => filter === "all" || m.type === filter);
  const enabledCount  = models.filter((m) => m.enabled).length;
  const disabledCount = models.filter((m) => !m.enabled).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-card border border-border rounded-2xl w-full max-w-2xl mx-4 shadow-2xl flex flex-col max-h-[90vh]">

        {/* Header */}
        <div className="px-6 py-4 border-b border-border flex items-center justify-between flex-shrink-0">
          <div>
            <h2 className="text-white font-semibold">Model Library</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {enabledCount} shown · {disabledCount} hidden · {models.length} total
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { setShowAdd((v) => !v); setError(null); }}
              className="text-xs px-3 py-1.5 rounded-lg border border-border text-slate-400 hover:text-white hover:border-slate-500 transition-colors"
            >
              + Add model
            </button>
            <button onClick={onClose} className="text-slate-500 hover:text-white text-lg leading-none ml-1">✕</button>
          </div>
        </div>

        {/* Add model form */}
        {showAdd && (
          <form onSubmit={handleAdd} className="px-6 py-4 border-b border-border bg-slate-900/50 space-y-3 flex-shrink-0">
            <p className="text-xs text-slate-400">
              Add any HuggingFace model vLLM supports. Find the model ID on{" "}
              <span className="text-cyan-400 font-mono">huggingface.co</span> (e.g.{" "}
              <span className="font-mono text-slate-300">mistralai/Mistral-7B-Instruct-v0.3</span>).
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label className="text-xs text-slate-500 mb-1 block">HuggingFace model ID *</label>
                <input value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} required
                  placeholder="org/model-name" className="w-full bg-slate-800 border border-border rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500 placeholder-slate-600 font-mono" />
              </div>
              <div>
                <label className="text-xs text-slate-500 mb-1 block">Display name</label>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Auto from ID" className="w-full bg-slate-800 border border-border rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500 placeholder-slate-600" />
              </div>
              <div>
                <label className="text-xs text-slate-500 mb-1 block">Type</label>
                <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as ModelEntry["type"] })}
                  className="w-full bg-slate-800 border border-border rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500">
                  <option value="chat">chat</option>
                  <option value="reasoning">reasoning</option>
                  <option value="embedding">embedding</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-slate-500 mb-1 block">Model size (B params)</label>
                <input type="number" value={form.size_b} onChange={(e) => setForm({ ...form, size_b: e.target.value ? Number(e.target.value) : "" })}
                  placeholder="e.g. 8" className="w-full bg-slate-800 border border-border rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500 placeholder-slate-600" />
              </div>
              <div>
                <label className="text-xs text-slate-500 mb-1 block">VRAM needed (GB)</label>
                <input type="number" value={form.vram_gb} onChange={(e) => setForm({ ...form, vram_gb: e.target.value ? Number(e.target.value) : "" })}
                  placeholder="e.g. 16" className="w-full bg-slate-800 border border-border rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500 placeholder-slate-600" />
              </div>
              <div>
                <label className="text-xs text-slate-500 mb-1 block">Native max context</label>
                <input type="number" value={form.max_context} onChange={(e) => setForm({ ...form, max_context: e.target.value ? Number(e.target.value) : "" })}
                  placeholder="e.g. 131072" className="w-full bg-slate-800 border border-border rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500 placeholder-slate-600" />
              </div>
              <div>
                <label className="text-xs text-slate-500 mb-1 block">Quantization</label>
                <input value={form.quantization} onChange={(e) => setForm({ ...form, quantization: e.target.value })}
                  placeholder="bf16 / fp8 / awq / gptq" className="w-full bg-slate-800 border border-border rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500 placeholder-slate-600" />
              </div>
              <div className="col-span-2">
                <label className="text-xs text-slate-500 mb-1 block">Extra vLLM flags (JSON)</label>
                <input value={form.flags_raw} onChange={(e) => setForm({ ...form, flags_raw: e.target.value })}
                  placeholder='{"trust_remote_code": true, "max_model_len": 32768}' className="w-full bg-slate-800 border border-border rounded-lg px-3 py-1.5 text-sm text-white font-mono focus:outline-none focus:border-blue-500 placeholder-slate-600" />
              </div>
              <div className="col-span-2">
                <label className="text-xs text-slate-500 mb-1 block">Description</label>
                <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })}
                  placeholder="Optional short description" className="w-full bg-slate-800 border border-border rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500 placeholder-slate-600" />
              </div>
            </div>
            {error && <p className="text-xs text-red-400">{error}</p>}
            <div className="flex gap-2 justify-end">
              <button type="button" onClick={() => { setShowAdd(false); setError(null); }} className="px-3 py-1.5 text-sm text-slate-400 hover:text-white transition-colors">Cancel</button>
              <button type="submit" disabled={saving} className="px-4 py-1.5 text-sm rounded-lg bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50 transition-colors">
                {saving ? "Adding…" : "Add to library"}
              </button>
            </div>
          </form>
        )}

        {/* Filter tabs */}
        <div className="px-6 pt-3 pb-0 flex gap-1 flex-shrink-0">
          {(["all", "chat", "reasoning", "embedding"] as const).map((f) => (
            <button key={f} onClick={() => setFilter(f)}
              className={`text-xs px-3 py-1 rounded-full transition-colors capitalize ${
                filter === f ? "bg-slate-700 text-white" : "text-slate-500 hover:text-white"
              }`}>
              {f}
            </button>
          ))}
        </div>

        {/* Model list */}
        <div className="overflow-y-auto flex-1 px-2 py-2">
          {loading ? (
            <p className="text-sm text-slate-500 text-center py-8">Loading…</p>
          ) : (
            <div className="space-y-1">
              {visible.map((model) => (
                <div key={model.id} className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors ${
                  model.enabled ? "hover:bg-slate-800/50" : "opacity-50 hover:bg-slate-800/30"
                }`}>
                  {/* Toggle */}
                  <button
                    onClick={() => toggle(model)}
                    className={`w-9 h-5 rounded-full transition-colors flex-shrink-0 relative ${
                      model.enabled ? "bg-blue-600" : "bg-slate-700"
                    }`}
                    title={model.enabled ? "Click to hide" : "Click to show"}
                  >
                    <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${
                      model.enabled ? "left-4" : "left-0.5"
                    }`} />
                  </button>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-white">{model.name}</span>
                      <span className={`text-xs px-1.5 py-0.5 rounded-full ${TYPE_COLORS[model.type] ?? "bg-slate-700 text-slate-300"}`}>
                        {model.type}
                      </span>
                      {model.cached && (
                        <span className="text-xs text-emerald-500">cached</span>
                      )}
                    </div>
                    <p className="text-xs text-slate-500 font-mono truncate">{model.id}</p>
                  </div>

                  {/* Stats */}
                  <div className="text-xs text-slate-500 text-right flex-shrink-0 hidden sm:block">
                    <p>{model.vram_gb} GB</p>
                    <p>{(model.max_context / 1024).toFixed(0)}K ctx</p>
                  </div>

                  {/* Delete */}
                  <button
                    onClick={() => remove(model)}
                    className="text-slate-700 hover:text-red-400 transition-colors text-sm flex-shrink-0 px-1"
                    title="Remove from library"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer note */}
        <div className="px-6 py-3 border-t border-border flex-shrink-0">
          <p className="text-xs text-slate-600">
            Models sourced from HuggingFace. Browse supported architectures at{" "}
            <span className="text-slate-500 font-mono">docs.vllm.ai/en/stable/models/supported_models.html</span>.
            The curated list covers popular open-weight models tested with vLLM on NVIDIA GPUs.
          </p>
        </div>
      </div>
    </div>
  );
}
