"use client";

import { useState, useEffect, useCallback } from "react";
import type { ClusterNodeStatus, NodeConfig, UpdateStatus } from "@/lib/types";
import { createNodeApi } from "@/lib/api";

interface Props {
  nodeStatuses: ClusterNodeStatus[];
  onRefresh: () => void;
}

type RowState = "idle" | "checking" | "pulling" | "waiting_restart" | "done" | "error";

function ago(ts: number | null): string {
  if (!ts) return "never";
  const sec = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function StatusPill({ u }: { u: UpdateStatus }) {
  if (u.error) return <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-900/30 text-red-300">error</span>;
  if (u.dirty) return <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-900/30 text-amber-300">dirty</span>;
  if (u.behind > 0) return <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-900/30 text-amber-300">{u.behind} behind</span>;
  if (u.ahead > 0) return <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-900/30 text-violet-300">{u.ahead} ahead</span>;
  return <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-900/30 text-emerald-400">up to date</span>;
}

export function SettingsView({ nodeStatuses, onRefresh }: Props) {
  const [rowStates, setRowStates] = useState<Record<string, RowState>>({});
  const [rowMessages, setRowMessages] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [repoUrls, setRepoUrls] = useState<Record<string, string>>({});
  const [branches, setBranches] = useState<Record<string, string>>({});
  const [autoPulls, setAutoPulls] = useState<Record<string, boolean>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);

  const nodeKey = (n: NodeConfig) => `${n.ip}:${n.agent_port}`;

  const setState = (n: NodeConfig, state: RowState, msg?: string) => {
    const k = nodeKey(n);
    setRowStates(prev => ({ ...prev, [k]: state }));
    if (msg !== undefined) setRowMessages(prev => ({ ...prev, [k]: msg }));
  };

  const checkNode = useCallback(async (n: NodeConfig) => {
    setState(n, "checking", "");
    try {
      await createNodeApi(n).updateCheck();
      setState(n, "idle", "");
      onRefresh();
    } catch (e) {
      setState(n, "error", String(e));
    }
  }, [onRefresh]);

  const pullNode = useCallback(async (n: NodeConfig) => {
    setState(n, "pulling", "");
    try {
      const res = await createNodeApi(n).updatePull();
      if (!res.pulled) {
        setState(n, "done", res.detail ?? "Already up to date");
        onRefresh();
        return;
      }
      setState(n, "waiting_restart",
        `Pulled ${res.from} → ${res.to}${res.changed?.length ? ` (${res.changed.length} files)` : ""}. Restarting…`);
      const until = Date.now() + 90_000;
      while (Date.now() < until) {
        await new Promise(r => setTimeout(r, 3000));
        try {
          await createNodeApi(n).updateStatus();
          setState(n, "done", "Update complete.");
          onRefresh();
          return;
        } catch { /* still restarting */ }
      }
      setState(n, "error", "Node did not come back in 90s — check agent.log");
    } catch (e) {
      setState(n, "error", String(e).replace(/^Error:\s*/, ""));
    }
  }, [onRefresh]);

  const updateAll = async () => {
    const targets = nodeStatuses.filter(ns => {
      const u = ns.status?.update;
      return u && u.behind > 0 && !u.dirty && !u.error;
    });
    for (const ns of targets) await pullNode(ns.node);
  };

  // Lazy-load repo config when a row is expanded for the first time
  const toggleExpand = async (n: NodeConfig) => {
    const k = nodeKey(n);
    const willOpen = !expanded[k];
    setExpanded(prev => ({ ...prev, [k]: willOpen }));
    if (willOpen && repoUrls[k] === undefined) {
      try {
        const cfg = await createNodeApi(n).updateConfigGet();
        setRepoUrls(prev  => ({ ...prev, [k]: cfg.repo_url }));
        setBranches(prev  => ({ ...prev, [k]: cfg.branch }));
        setAutoPulls(prev => ({ ...prev, [k]: cfg.auto_pull_on_start }));
      } catch {
        const u = nodeStatuses.find(ns => nodeKey(ns.node) === k)?.status?.update;
        setRepoUrls(prev  => ({ ...prev, [k]: u?.repo_url ?? "" }));
        setBranches(prev  => ({ ...prev, [k]: u?.branch ?? "main" }));
        setAutoPulls(prev => ({ ...prev, [k]: true }));
      }
    }
  };

  const saveConfig = async (n: NodeConfig) => {
    const k = nodeKey(n);
    setSavingKey(k);
    try {
      await createNodeApi(n).updateConfigSet(
        (repoUrls[k] ?? "").trim(),
        (branches[k] ?? "main").trim(),
        autoPulls[k] ?? true,
      );
      setState(n, "idle", "Config saved. Refreshing status…");
      onRefresh();
    } catch (e) {
      setState(n, "error", `Save failed: ${e}`);
    } finally {
      setSavingKey(null);
    }
  };

  useEffect(() => { /* no-op for now */ }, []);

  const anyCanUpdate = nodeStatuses.some(ns => {
    const u = ns.status?.update;
    return u && u.behind > 0 && !u.dirty && !u.error;
  });

  return (
    <div className="space-y-4">

      {/* Cluster updates section */}
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-white">Cluster updates</p>
            <p className="text-[11px] text-slate-500 mt-0.5">Each node pulls from its own git remote independently.</p>
          </div>
          <div className="flex items-center gap-2">
            {anyCanUpdate && (
              <button
                onClick={updateAll}
                className="text-xs px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white transition-colors"
              >
                Update all
              </button>
            )}
          </div>
        </div>

        <div className="divide-y divide-border">
          {nodeStatuses.map((ns) => {
            const n = ns.node;
            const k = nodeKey(n);
            const u = ns.status?.update;
            const rowState = rowStates[k] ?? "idle";
            const rowMessage = rowMessages[k] ?? "";
            const busy = rowState === "checking" || rowState === "pulling" || rowState === "waiting_restart";
            const isExpanded = !!expanded[k];

            return (
              <div key={k} className="px-4 py-3 space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-medium text-white">{n.name}</p>
                      <span className="text-[10px] text-slate-600 font-mono">{n.ip}</span>
                      {!ns.status && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-500">offline</span>
                      )}
                      {u && <StatusPill u={u} />}
                    </div>
                    {u && (
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-slate-500">
                        <span className="font-mono">{u.local_sha ?? "?"} → {u.remote_sha ?? "?"}</span>
                        <span>branch: <span className="text-slate-300">{u.branch}</span></span>
                        <span>checked {ago(u.last_checked)}</span>
                      </div>
                    )}
                    {u?.error && (
                      <p className="text-[11px] text-red-400 mt-1">{u.error}</p>
                    )}
                    {rowMessage && (
                      <p className={`text-[11px] mt-1 ${rowState === "error" ? "text-red-400" : "text-slate-400"}`}>
                        {rowMessage}
                      </p>
                    )}
                  </div>

                  <div className="shrink-0 flex items-center gap-1.5">
                    <button
                      onClick={() => toggleExpand(n)}
                      disabled={!ns.status}
                      className="text-[11px] px-2 py-1 rounded border border-border text-slate-400 hover:text-white hover:border-slate-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      title="Edit git remote"
                    >
                      ⚙
                    </button>
                    <button
                      onClick={() => checkNode(n)}
                      disabled={busy || !ns.status}
                      className="text-[11px] px-2 py-1 rounded border border-border text-slate-400 hover:text-white hover:border-slate-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      {rowState === "checking" ? "checking…" : "Check"}
                    </button>
                    <button
                      onClick={() => pullNode(n)}
                      disabled={busy || !u || u.behind === 0 || u.dirty || !!u.error}
                      className="text-[11px] px-3 py-1 rounded bg-cyan-600 hover:bg-cyan-500 text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                      title={
                        !u ? "No update data"
                        : u.dirty ? "Local uncommitted changes — commit or stash first"
                        : u.behind === 0 ? "Already up to date"
                        : u.error ? "Check failed — retry first"
                        : "Pull and restart"
                      }
                    >
                      {rowState === "pulling"          ? "pulling…"
                       : rowState === "waiting_restart" ? "restarting…"
                       : rowState === "done"            ? "✓"
                       : "Update"}
                    </button>
                  </div>
                </div>

                {/* Inline repo config editor */}
                {isExpanded && (
                  <div className="bg-slate-800/40 rounded-lg px-3 py-2.5 space-y-2 mt-2">
                    <div className="flex flex-wrap items-end gap-2">
                      <div className="flex-1 min-w-[260px] space-y-1">
                        <label className="text-[10px] text-slate-500 uppercase tracking-wider">Repo URL</label>
                        <input
                          type="text"
                          value={repoUrls[k] ?? ""}
                          onChange={(e) => setRepoUrls(prev => ({ ...prev, [k]: e.target.value }))}
                          className="w-full text-xs bg-slate-900 border border-border rounded-lg px-2 py-1.5 text-white font-mono"
                          placeholder="https://github.com/org/repo.git"
                        />
                      </div>
                      <div className="w-36 space-y-1">
                        <label className="text-[10px] text-slate-500 uppercase tracking-wider">Branch</label>
                        <input
                          type="text"
                          value={branches[k] ?? ""}
                          onChange={(e) => setBranches(prev => ({ ...prev, [k]: e.target.value }))}
                          className="w-full text-xs bg-slate-900 border border-border rounded-lg px-2 py-1.5 text-white font-mono"
                          placeholder="main"
                        />
                      </div>
                      <button
                        onClick={() => saveConfig(n)}
                        disabled={savingKey === k || !(repoUrls[k] ?? "").trim()}
                        className="text-xs px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      >
                        {savingKey === k ? "Saving…" : "Save"}
                      </button>
                    </div>
                    <label className="flex items-center gap-2 text-[11px] text-slate-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={autoPulls[k] ?? true}
                        onChange={(e) => setAutoPulls(prev => ({ ...prev, [k]: e.target.checked }))}
                        className="accent-cyan-500 w-3.5 h-3.5"
                      />
                      Auto-pull on <span className="font-mono text-slate-400">./node.sh start</span>
                      <span className="text-slate-600">— fast-forwards from origin if clean, skips on dirty tree or network failure</span>
                    </label>
                    <p className="text-[10px] text-slate-600">Written to this node&apos;s node_config.json and its git remote.</p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

    </div>
  );
}
