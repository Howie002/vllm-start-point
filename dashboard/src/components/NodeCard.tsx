"use client";

import { useState, useEffect, useCallback } from "react";
import type { FullStatus, NodeConfig, ModelEntry } from "@/lib/types";
import { createNodeApi } from "@/lib/api";
import { GPUGrid } from "./GPUGrid";
import { ServiceList } from "./ServiceList";
import { ModelLibrary } from "./ModelLibrary";
import { StackConfigs } from "./StackConfigs";
import { ModelLibraryManager } from "./ModelLibraryManager";

const POLL_MS = 8000;

interface Props {
  node: NodeConfig;
  library: ModelEntry[];
  defaultOpen?: boolean;
  onLibraryChanged?: () => void;
}

export function NodeCard({ node, library, defaultOpen = true, onLibraryChanged }: Props) {
  const [status, setStatus]               = useState<FullStatus | null>(null);
  const [error, setError]                 = useState<string | null>(null);
  const [open, setOpen]                   = useState(defaultOpen);
  const [agentBusy, setAgentBusy]         = useState<"restarting" | "stopping" | null>(null);
  const [showLibMgr, setShowLibMgr]       = useState(false);

  const refresh = useCallback(async () => {
    try {
      const api = createNodeApi(node);
      const s = await api.status();
      setStatus(s);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [node]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  async function handleRestart() {
    if (!confirm(`Restart the agent on ${node.name}? Running vLLM instances will keep running.`)) return;
    setAgentBusy("restarting");
    try {
      await createNodeApi(node).restartAgent();
      // Wait a moment then re-poll
      await new Promise((r) => setTimeout(r, 2000));
      await refresh();
    } catch {
      // Expected — agent drops the connection during restart
      await new Promise((r) => setTimeout(r, 3000));
      await refresh();
    } finally {
      setAgentBusy(null);
    }
  }

  async function handleStop() {
    if (!confirm(`Stop the agent on ${node.name}? This only stops the control agent, not running vLLM instances.`)) return;
    setAgentBusy("stopping");
    try {
      await createNodeApi(node).stopAgent();
    } catch {
      // Expected — connection drops immediately
    } finally {
      setAgentBusy(null);
      setStatus(null);
      setError("Agent stopped.");
    }
  }

  const online = !!status && !error;
  const totalVram = status?.gpus.reduce((a, g) => a + g.vram_total_mb, 0) ?? 0;
  const usedVram  = status?.gpus.reduce((a, g) => a + g.vram_used_mb,  0) ?? 0;

  return (
    <div className="border border-border rounded-2xl overflow-hidden">
      {/* Node header */}
      <button
        className="w-full flex items-center gap-3 px-5 py-4 bg-card hover:bg-slate-800/60 transition-colors text-left"
        onClick={() => setOpen((o) => !o)}
      >
        <span
          className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
            online ? "bg-emerald-400" : error ? "bg-red-500" : "bg-slate-600 animate-pulse"
          }`}
        />
        <span className="font-semibold text-white">{node.name}</span>
        <span className="text-slate-500 text-sm font-mono">
          {node.ip}:{node.agent_port}
        </span>

        {online && (
          <>
            <span className="ml-auto text-xs text-slate-400">
              {status!.gpus.length} GPU{status!.gpus.length !== 1 ? "s" : ""}
            </span>
            <span className="text-xs text-slate-500 hidden sm:inline">
              {(usedVram / 1024).toFixed(0)}/{(totalVram / 1024).toFixed(0)} GB VRAM
            </span>
            <span className="text-xs text-slate-500">
              {status!.instances.length} instance{status!.instances.length !== 1 ? "s" : ""}
            </span>
          </>
        )}

        {error && !agentBusy && (
          <span className="ml-auto text-xs text-red-400">unreachable</span>
        )}

        {/* Agent controls — stop propagation so they don't toggle expand */}
        {online && (
          <div className="flex items-center gap-1 ml-auto" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={handleRestart}
              disabled={!!agentBusy}
              className="text-xs px-2 py-0.5 rounded text-slate-500 hover:text-blue-400 hover:bg-slate-700/50 disabled:opacity-40 transition-colors"
              title="Restart agent"
            >
              {agentBusy === "restarting" ? "Restarting…" : "Restart agent"}
            </button>
            <button
              onClick={handleStop}
              disabled={!!agentBusy}
              className="text-xs px-2 py-0.5 rounded text-slate-500 hover:text-red-400 hover:bg-slate-700/50 disabled:opacity-40 transition-colors"
              title="Stop agent"
            >
              {agentBusy === "stopping" ? "Stopping…" : "Stop agent"}
            </button>
          </div>
        )}

        <span className="text-slate-600 text-sm">{open ? "▲" : "▼"}</span>
      </button>

      {/* Expanded content */}
      {open && (
        <div className="p-5 space-y-6 bg-surface border-t border-border">
          {error ? (
            <p className="text-sm text-red-400 bg-red-900/20 border border-red-800 rounded-xl px-4 py-3">
              Cannot reach agent at <code className="font-mono">{node.ip}:{node.agent_port}</code>
              . Ensure <code className="font-mono">./node.sh start</code> has been run on that machine.
            </p>
          ) : status ? (
            <>
              <GPUGrid gpus={status.gpus} instances={status.instances} />
              <ServiceList
                instances={status.instances}
                proxy={status.proxy}
                node={node}
                onRefresh={refresh}
              />
              <StackConfigs node={node} onRefresh={refresh} />
              {library.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-slate-500 font-medium uppercase tracking-wider">Model Library</span>
                    <button
                      onClick={() => setShowLibMgr(true)}
                      className="text-xs px-2.5 py-1 rounded-lg border border-border text-slate-400 hover:text-white hover:border-slate-500 transition-colors"
                    >
                      Manage library
                    </button>
                  </div>
                  <ModelLibrary
                    models={library}
                    gpus={status.gpus}
                    instances={status.instances}
                    node={node}
                    onRefresh={refresh}
                  />
                </div>
              )}
              {showLibMgr && (
                <ModelLibraryManager
                  node={node}
                  onClose={() => setShowLibMgr(false)}
                  onChanged={() => { onLibraryChanged?.(); refresh(); }}
                />
              )}
            </>
          ) : (
            <p className="text-sm text-slate-500 text-center py-4">Connecting…</p>
          )}
        </div>
      )}
    </div>
  );
}
