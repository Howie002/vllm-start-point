"use client";

import { useState } from "react";
import type { FullStatus, NodeConfig } from "@/lib/types";
import { createNodeApi, renameNode } from "@/lib/api";
import { StackConfigs } from "./StackConfigs";

interface Props {
  node: NodeConfig;
  status: FullStatus | null;
  error: string | null;
  onRefresh: () => void;
  // Called after a successful rename so the parent can re-fetch the node list
  // from the Next.js route (single source of truth: master's node_config.json).
  onNodesChanged?: () => void;
}

export function NodeCard({ node, status, error, onRefresh, onNodesChanged }: Props) {
  const [open, setOpen]           = useState(false);
  const [agentBusy, setAgentBusy] = useState<"restarting" | "stopping" | null>(null);
  const [dashBusy, setDashBusy]   = useState<"restarting" | null>(null);
  const [editing, setEditing]     = useState(false);
  const [draft, setDraft]         = useState(node.name);
  const [renamingBusy, setRenamingBusy] = useState(false);

  async function handleRename() {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === node.name) { setEditing(false); return; }
    setRenamingBusy(true);
    try {
      await renameNode(node.ip, node.agent_port, trimmed);
      setEditing(false);
      onNodesChanged?.();
    } catch (e) {
      alert(`Rename failed: ${e}`);
    } finally {
      setRenamingBusy(false);
    }
  }

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

        {editing ? (
          <span className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
            <input
              autoFocus
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter") handleRename();
                if (e.key === "Escape") { setDraft(node.name); setEditing(false); }
              }}
              disabled={renamingBusy}
              className="bg-slate-900 border border-cyan-700 rounded px-2 py-0.5 text-sm text-white w-40"
            />
            <button
              onClick={handleRename}
              disabled={renamingBusy}
              className="text-xs px-2 py-0.5 rounded bg-cyan-900/50 text-cyan-300 hover:bg-cyan-800/60 disabled:opacity-40"
            >
              {renamingBusy ? "Saving…" : "Save"}
            </button>
            <button
              onClick={() => { setDraft(node.name); setEditing(false); }}
              disabled={renamingBusy}
              className="text-xs px-2 py-0.5 rounded text-slate-400 hover:text-white disabled:opacity-40"
            >
              Cancel
            </button>
          </span>
        ) : (
          <>
            <span className="text-sm font-medium text-white">{node.name}</span>
            <button
              onClick={e => { e.stopPropagation(); setDraft(node.name); setEditing(true); }}
              className="text-xs text-slate-600 hover:text-cyan-400 transition-colors px-1 -ml-1"
              title="Rename node"
            >
              ✎
            </button>
          </>
        )}

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
