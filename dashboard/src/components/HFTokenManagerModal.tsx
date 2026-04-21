"use client";

import { useEffect, useState, useCallback } from "react";
import type { NodeConfig, HFTokenStatus } from "@/lib/types";
import { createNodeApi } from "@/lib/api";

interface Props {
  nodes: NodeConfig[];
  onClose: () => void;
  onChanged?: () => void;
}

// Per-node HF token manager. Each node's token lives at that node's
// ~/.cache/huggingface/token — we never store it in the dashboard, just
// proxy set/clear commands to each agent.
export function HFTokenManagerModal({ nodes, onClose, onChanged }: Props) {
  const [statuses, setStatuses] = useState<Record<string, HFTokenStatus>>({});
  const [drafts, setDrafts]     = useState<Record<string, string>>({});
  const [busy, setBusy]         = useState<string | null>(null);
  const [error, setError]       = useState<string | null>(null);

  const key = (n: NodeConfig) => `${n.ip}:${n.agent_port}`;

  const refresh = useCallback(async () => {
    const result: Record<string, HFTokenStatus> = {};
    await Promise.all(nodes.map(async n => {
      try {
        result[key(n)] = await createNodeApi(n).hfTokenStatus();
      } catch (e) {
        result[key(n)] = { set: false };
        console.warn(`HF token status failed for ${n.name}:`, e);
      }
    }));
    setStatuses(result);
  }, [nodes]);

  useEffect(() => { refresh(); }, [refresh]);

  async function save(node: NodeConfig) {
    const token = (drafts[key(node)] ?? "").trim();
    if (!token) return;
    setBusy(key(node)); setError(null);
    try {
      const s = await createNodeApi(node).hfTokenSet(token);
      setStatuses(prev => ({ ...prev, [key(node)]: s }));
      setDrafts(prev => ({ ...prev, [key(node)]: "" }));
      onChanged?.();
    } catch (e) {
      setError(`${node.name}: ${e}`);
    } finally {
      setBusy(null);
    }
  }

  async function clear(node: NodeConfig) {
    if (!confirm(`Clear HF token on ${node.name}? vLLM instances already running keep their cached credentials until restart.`)) return;
    setBusy(key(node)); setError(null);
    try {
      const s = await createNodeApi(node).hfTokenClear();
      setStatuses(prev => ({ ...prev, [key(node)]: s }));
      onChanged?.();
    } catch (e) {
      setError(`${node.name}: ${e}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-card border border-border rounded-xl max-w-2xl w-full max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-border">
          <h2 className="text-base font-semibold text-white">HuggingFace Tokens — per node</h2>
          <p className="text-xs text-slate-500 mt-1">
            Tokens are written to <span className="font-mono">~/.cache/huggingface/token</span> on each node and used by vLLM when pulling gated repos. Tokens never leave the dashboard unencrypted in any store.
          </p>
        </div>

        <div className="divide-y divide-border">
          {nodes.map(node => {
            const k  = key(node);
            const st = statuses[k];
            const isBusy = busy === k;
            return (
              <div key={k} className="px-5 py-4">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-sm font-medium text-white">{node.name}</span>
                  <span className="text-xs font-mono text-slate-500">{node.ip}</span>
                  {st?.set ? (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-900/40 text-emerald-300 ml-auto">
                      token set · <span className="font-mono">{st.preview}</span>
                    </span>
                  ) : (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 ml-auto">no token</span>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <input
                    type="password"
                    placeholder="hf_xxxxxxxxxxxxxxxxx"
                    value={drafts[k] ?? ""}
                    onChange={e => setDrafts(prev => ({ ...prev, [k]: e.target.value }))}
                    disabled={isBusy}
                    className="flex-1 bg-slate-900 border border-border rounded px-3 py-1.5 text-sm text-white font-mono"
                  />
                  <button
                    onClick={() => save(node)}
                    disabled={isBusy || !(drafts[k] ?? "").trim()}
                    className="text-xs px-3 py-1.5 rounded bg-cyan-900/50 text-cyan-300 hover:bg-cyan-800/60 disabled:opacity-40"
                  >
                    {isBusy ? "Saving…" : st?.set ? "Replace" : "Set token"}
                  </button>
                  {st?.set && (
                    <button
                      onClick={() => clear(node)}
                      disabled={isBusy}
                      className="text-xs px-3 py-1.5 rounded bg-red-900/40 text-red-300 hover:bg-red-800/60 disabled:opacity-40"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {error && (
          <div className="px-5 py-3 border-t border-border bg-red-950/30 text-xs text-red-300">{error}</div>
        )}

        <div className="px-5 py-3 border-t border-border flex justify-end">
          <button onClick={onClose} className="text-xs px-4 py-1.5 rounded bg-slate-700 text-white hover:bg-slate-600">Close</button>
        </div>
      </div>
    </div>
  );
}
