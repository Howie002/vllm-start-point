"use client";

import { useState } from "react";
import type { NodeConfig, HFLookup, ModelEntry } from "@/lib/types";
import { createNodeApi } from "@/lib/api";

interface Props {
  // Any online node whose agent.py is new enough to serve /models/hf/lookup —
  // the caller passes the "first online" node.
  node: NodeConfig;
  onClose: () => void;
  onAdded: (entry: ModelEntry) => void;
}

// Paste a HuggingFace URL or `org/repo` string. We hit the node's HF lookup
// endpoint to prefill metadata, user reviews, we POST to /models/library.
export function HFImporterModal({ node, onClose, onAdded }: Props) {
  const [input, setInput]       = useState("");
  const [loading, setLoading]   = useState(false);
  const [lookup, setLookup]     = useState<HFLookup | null>(null);
  const [error, setError]       = useState<string | null>(null);

  // Editable overrides once we have a lookup result.
  const [displayName, setDisplayName]   = useState("");
  const [family, setFamily]             = useState("");
  const [description, setDescription]   = useState("");

  function extractRepoId(raw: string): string {
    raw = raw.trim();
    // HuggingFace URL variants:
    //   https://huggingface.co/org/repo
    //   https://huggingface.co/org/repo/tree/main
    //   huggingface.co/org/repo
    const m = raw.match(/huggingface\.co\/([^/]+\/[^/?#]+)/);
    if (m) return m[1];
    return raw;
  }

  async function runLookup() {
    const id = extractRepoId(input);
    if (!id.includes("/")) {
      setError("Enter a HuggingFace URL or an 'org/repo' string.");
      return;
    }
    setLoading(true); setError(null); setLookup(null);
    try {
      const result = await createNodeApi(node).hfLookup(id);
      if (result.status !== "ok") {
        setError(`${result.status}: ${result.message ?? "unknown"}${result.status === "gated_unauthorized" ? " — set an HF token on this node first." : ""}`);
        setLookup(null);
      } else {
        setLookup(result);
        // Sensible defaults for the editable fields
        const shortName = id.split("/")[1]
          .replace(/[_-]/g, " ")
          .replace(/\b\w/g, c => c.toUpperCase());
        setDisplayName(shortName);
        setFamily(detectFamily(id));
        setDescription(`${result.params_b ? `${result.params_b}B parameter ` : ""}${result.type ?? "chat"} model from HuggingFace. Imported from ${id}.`);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function save() {
    if (!lookup) return;
    setLoading(true); setError(null);
    try {
      const entry: Partial<ModelEntry> = {
        id:            lookup.model_id,
        name:          displayName.trim() || lookup.model_id.split("/")[1],
        family,
        type:          (lookup.type ?? "chat") as "chat" | "reasoning" | "embedding",
        size_b:        lookup.params_b ?? 0,
        vram_gb:       lookup.vram_gb_estimate ?? 0,
        min_gpus:      1,
        quantization:  lookup.quant_guess ?? "bf16",
        max_context:   lookup.context_length ?? 32768,
        description,
        flags:         {},
        enabled:       true,
      };
      const added = await createNodeApi(node).addModel(entry);
      onAdded(added);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-card border border-border rounded-xl max-w-xl w-full max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-border">
          <h2 className="text-base font-semibold text-white">Import from HuggingFace</h2>
          <p className="text-xs text-slate-500 mt-1">
            Paste a HuggingFace URL or <span className="font-mono">org/repo</span>. The node&apos;s HF API call prefills the metadata.
          </p>
        </div>

        <div className="p-5 space-y-4">
          <div>
            <label className="text-xs text-slate-400 uppercase tracking-wider">HuggingFace repo</label>
            <div className="mt-1 flex gap-2">
              <input
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && !loading) runLookup(); }}
                placeholder="https://huggingface.co/meta-llama/Llama-3.1-8B-Instruct"
                className="flex-1 bg-slate-900 border border-border rounded px-3 py-1.5 text-sm text-white font-mono"
              />
              <button
                onClick={runLookup}
                disabled={loading || !input.trim()}
                className="text-xs px-3 py-1.5 rounded bg-cyan-900/50 text-cyan-300 hover:bg-cyan-800/60 disabled:opacity-40"
              >
                {loading ? "Looking up…" : "Look up"}
              </button>
            </div>
          </div>

          {error && (
            <div className="px-3 py-2 rounded bg-red-950/40 border border-red-800 text-xs text-red-300">{error}</div>
          )}

          {lookup && (
            <div className="space-y-3 border-t border-border pt-4">
              <div className="grid grid-cols-2 gap-3 text-xs">
                <Field label="Model ID"         value={lookup.model_id} mono />
                <Field label="Type"             value={lookup.type ?? "—"} />
                <Field label="Parameters"       value={lookup.params_b ? `${lookup.params_b}B` : "unknown"} />
                <Field label="VRAM estimate"    value={lookup.vram_gb_estimate ? `${lookup.vram_gb_estimate} GB` : "unknown"} />
                <Field label="Context length"   value={lookup.context_length?.toLocaleString() ?? "unknown"} />
                <Field label="Quantization guess" value={lookup.quant_guess ?? "bf16"} />
                <Field label="On-disk size"     value={lookup.total_bytes ? formatBytes(lookup.total_bytes) : "unknown"} />
                <Field label="License"          value={lookup.license ?? "not listed"} />
              </div>

              {lookup.gated && (
                <div className="px-3 py-2 rounded bg-amber-950/40 border border-amber-800 text-xs text-amber-300">
                  This repo is gated. The node&apos;s HF token has access, so downloads will work here — but confirm other nodes have their own tokens before deploying there.
                </div>
              )}

              <div className="space-y-3 border-t border-border pt-3">
                <EditField label="Display name" value={displayName} onChange={setDisplayName} />
                <EditField label="Family"       value={family}      onChange={setFamily}      placeholder="llama / qwen / nemotron / ..." />
                <EditField label="Description"  value={description} onChange={setDescription} textarea />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button onClick={onClose} className="text-xs px-4 py-1.5 rounded text-slate-400 hover:text-white">Cancel</button>
                <button
                  onClick={save}
                  disabled={loading}
                  className="text-xs px-4 py-1.5 rounded bg-cyan-700 hover:bg-cyan-600 text-white disabled:opacity-40"
                >
                  {loading ? "Saving…" : "Add to Library"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-slate-500 uppercase tracking-wider">{label}</p>
      <p className={`text-slate-200 mt-0.5 ${mono ? "font-mono break-all" : ""}`}>{value}</p>
    </div>
  );
}

function EditField({ label, value, onChange, placeholder, textarea }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; textarea?: boolean;
}) {
  return (
    <div>
      <label className="text-xs text-slate-400 uppercase tracking-wider">{label}</label>
      {textarea ? (
        <textarea
          value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
          className="w-full mt-1 bg-slate-900 border border-border rounded px-3 py-1.5 text-sm text-slate-200"
          rows={2}
        />
      ) : (
        <input
          value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
          className="w-full mt-1 bg-slate-900 border border-border rounded px-3 py-1.5 text-sm text-slate-200"
        />
      )}
    </div>
  );
}


function detectFamily(id: string): string {
  const l = id.toLowerCase();
  if (l.includes("nemotron")) return "nemotron";
  if (l.includes("llama"))    return "llama";
  if (l.includes("qwen"))     return "qwen";
  if (l.includes("mistral"))  return "mistral";
  if (l.includes("deepseek")) return "deepseek";
  if (l.includes("phi"))      return "phi";
  if (l.includes("gemma"))    return "gemma";
  if (l.includes("bert"))     return "bert";
  return "other";
}

function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024)      return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}
