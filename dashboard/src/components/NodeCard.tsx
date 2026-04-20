"use client";

import { useState } from "react";
import type { FullStatus, NodeConfig } from "@/lib/types";
import { createNodeApi } from "@/lib/api";
import { StackConfigs } from "./StackConfigs";

interface Props {
  node: NodeConfig;
  status: FullStatus | null;
  error: string | null;
  onRefresh: () => void;
}

export function NodeCard({ node, status, error, onRefresh }: Props) {
  const [open, setOpen]           = useState(false);
  const [agentBusy, setAgentBusy] = useState<"restarting" | "stopping" | null>(null);
  const [dashBusy, setDashBusy]   = useState<"restarting" | null>(null);

  const online = !!status && !error;

  async function handleRestart() {
    if (!confirm(`Restart the agent on ${node.name}? Running vLLM instances will keep running.`)) return;
    setAgentBusy("restarting");
    try {
      await createNodeApi(node).restartAgent();
      await new Promise(r => setTimeout(r, 2000));
      await onRefresh();
    } catch {
      await new Promise(r => setTimeout(r, 3000));
      await onRefresh();
    } finally {
      setAgentBusy(null);
    }
  }

  async function handleStop() {
    if (!confirm(`Stop the agent on ${node.name}? Running vLLM instances will keep running.`)) return;
    setAgentBusy("stopping");
    try { await createNodeApi(node).stopAgent(); } catch { /* expected */ }
    setAgentBusy(null);
    onRefresh();
  }

  async function handleDashboardRestart() {
    if (!confirm("Rebuild and restart the dashboard? This takes ~1 minute. The page will go offline briefly.")) return;
    setDashBusy("restarting");
    try { await createNodeApi(node).restartDashboard(); } catch { /* expected */ }
    await new Promise(r => setTimeout(r, 60000));
    window.location.reload();
  }

  return (
    <div className="border border-border rounded-xl overflow-hidden">
      <button
        className="w-full flex items-center gap-3 px-4 py-3 bg-card hover:bg-slate-800/50 transition-colors text-left"
        onClick={() => setOpen(o => !o)}
      >
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
          online ? "bg-emerald-400" : error ? "bg-red-500" : "bg-slate-600 animate-pulse"
        }`} />
        <span className="text-sm font-medium text-white">{node.name}</span>
        <span className="text-xs text-slate-500 font-mono">{node.ip}:{node.agent_port}</span>

        {online && (
          <div className="flex items-center gap-1 ml-auto" onClick={e => e.stopPropagation()}>
            <button
              onClick={handleDashboardRestart}
              disabled={!!dashBusy || !!agentBusy}
              className="text-xs px-2 py-0.5 rounded text-slate-500 hover:text-emerald-400 hover:bg-slate-700/50 disabled:opacity-40 transition-colors"
            >
              {dashBusy === "restarting" ? "Building…" : "Restart dashboard"}
            </button>
            <span className="text-slate-700 text-xs">|</span>
            <button
              onClick={handleRestart}
              disabled={!!agentBusy || !!dashBusy}
              className="text-xs px-2 py-0.5 rounded text-slate-500 hover:text-blue-400 hover:bg-slate-700/50 disabled:opacity-40 transition-colors"
            >
              {agentBusy === "restarting" ? "Restarting…" : "Restart agent"}
            </button>
            <button
              onClick={handleStop}
              disabled={!!agentBusy || !!dashBusy}
              className="text-xs px-2 py-0.5 rounded text-slate-500 hover:text-red-400 hover:bg-slate-700/50 disabled:opacity-40 transition-colors"
            >
              {agentBusy === "stopping" ? "Stopping…" : "Stop agent"}
            </button>
          </div>
        )}

        {!online && error && (
          <span className="text-xs text-red-400 ml-auto">unreachable</span>
        )}

        <span className="text-slate-600 text-xs ml-2">
          {open ? "▲" : "▼"} Stack Templates
        </span>
      </button>

      {open && (
        <div className="px-4 pb-4 pt-3 bg-surface border-t border-border">
          {online ? (
            <StackConfigs node={node} onRefresh={onRefresh} />
          ) : (
            <p className="text-xs text-slate-500 py-2">Agent must be online to manage stack templates.</p>
          )}
        </div>
      )}
    </div>
  );
}
