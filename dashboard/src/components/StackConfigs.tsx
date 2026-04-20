"use client";

import { useState, useEffect, useCallback } from "react";
import type { StackConfig, PreflightResult, PreflightCheck, RepackResult, RepackAssignment, NodeConfig } from "@/lib/types";
import { createNodeApi } from "@/lib/api";

interface Props {
  node: NodeConfig;
  onRefresh: () => void;
}

// ── Preflight panel ───────────────────────────────────────────────────────────

function vramBar(used: number, total: number, color: string) {
  const pct = total > 0 ? Math.min((used / total) * 100, 100) : 0;
  return (
    <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden mt-1">
      <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function CheckRow({ c }: { c: PreflightCheck }) {
  const status = c.already_running
    ? { label: "Already running", cls: "text-blue-400", dot: "bg-blue-400" }
    : c.fits
    ? { label: "Fits", cls: "text-emerald-400", dot: "bg-emerald-400" }
    : { label: "Won't fit", cls: "text-red-400", dot: "bg-red-400 animate-pulse" };

  const headroom = c.fits && !c.already_running
    ? ((c.available_vram_gb - c.required_vram_gb) / c.available_vram_gb) * 100
    : null;

  const barColor = c.already_running
    ? "bg-blue-500"
    : c.fits
    ? headroom !== null && headroom < 10 ? "bg-amber-400" : "bg-emerald-500"
    : "bg-red-500";

  return (
    <div className="bg-slate-800/60 rounded-lg px-3 py-2.5 space-y-1.5">
      {/* Model name + status */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${status.dot}`} />
          <span className="text-sm font-medium text-white truncate">{c.served_name}</span>
          <span className="text-xs text-slate-500 font-mono flex-shrink-0">:{c.port}</span>
        </div>
        <span className={`text-xs font-medium flex-shrink-0 ${status.cls}`}>{status.label}</span>
      </div>

      {/* GPU assignment */}
      <div className="flex items-center justify-between text-xs text-slate-500">
        <span>GPU {c.gpu_indices.join("+")} &nbsp;·&nbsp; {Math.round(c.gpu_memory_utilization * 100)}% util</span>
        <span>{c.required_vram_gb} GB needed</span>
      </div>

      {/* VRAM bar */}
      {!c.already_running && (
        <>
          <div className="flex justify-between text-xs text-slate-500">
            <span>{c.available_vram_gb} GB free of {c.total_vram_gb} GB</span>
            {headroom !== null && (
              <span className={headroom < 10 ? "text-amber-400" : "text-slate-500"}>
                {headroom.toFixed(0)}% headroom
              </span>
            )}
          </div>
          {vramBar(c.required_vram_gb, c.total_vram_gb, barColor)}
        </>
      )}

      {/* Suggestions */}
      {!c.fits && !c.already_running && (
        <div className="text-xs text-slate-400 pt-0.5 space-y-0.5">
          {c.alternative_gpus.length > 0 && (
            <p>
              <span className="text-amber-400">→ Alternative GPU{c.alternative_gpus.length > 1 ? "s" : ""}:</span>
              {" "}{c.alternative_gpus.map((g) => `GPU ${g}`).join(", ")} have enough free VRAM
            </p>
          )}
          {c.suggested_utilization !== null && (
            <p>
              <span className="text-amber-400">→ Lower utilization to</span>
              {" "}{Math.round(c.suggested_utilization * 100)}% to fit on current GPU
            </p>
          )}
          {c.alternative_gpus.length === 0 && c.suggested_utilization === null && (
            <p className="text-red-400">No GPU has sufficient free VRAM for this model.</p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Repack panel ──────────────────────────────────────────────────────────────

function RepackRow({ a }: { a: RepackAssignment }) {
  const unchanged    = a.status === "unchanged" || a.status === "already_running";
  const gpuChanged   = a.status === "reassigned" || a.status === "reassigned+adjusted";
  const utilChanged  = a.status === "adjusted"   || a.status === "reassigned+adjusted";

  return (
    <div className="bg-slate-800/60 rounded-lg px-3 py-2.5 flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium text-white truncate">{a.served_name}</span>
          <span className="text-xs text-slate-500 font-mono">:{a.port}</span>
          {a.status === "already_running" && (
            <span className="text-xs text-blue-400 ml-1">already running</span>
          )}
        </div>

        <div className="flex items-center gap-2 mt-1 text-xs flex-wrap">
          {/* GPU assignment */}
          {gpuChanged ? (
            <span>
              <span className="text-slate-500">GPU {a.original_gpu}</span>
              <span className="text-slate-600"> → </span>
              <span className="text-emerald-400 font-medium">GPU {a.new_gpu}</span>
            </span>
          ) : (
            <span className="text-slate-500">GPU {a.new_gpu}</span>
          )}

          <span className="text-slate-700">·</span>

          {/* Utilization */}
          {utilChanged ? (
            <span>
              <span className="text-slate-500">{Math.round(a.original_utilization * 100)}%</span>
              <span className="text-slate-600"> → </span>
              <span className="text-amber-400 font-medium">{Math.round(a.new_utilization * 100)}%</span>
              <span className="text-slate-600"> util</span>
            </span>
          ) : (
            <span className="text-slate-500">{Math.round(a.new_utilization * 100)}% util</span>
          )}

          {a.vram_required_gb != null && (
            <>
              <span className="text-slate-700">·</span>
              <span className="text-slate-500">{a.vram_required_gb} GB allocated</span>
            </>
          )}
        </div>
      </div>

      {/* Status badge */}
      <div className="flex-shrink-0">
        {unchanged ? (
          <span className="text-xs text-slate-600">—</span>
        ) : gpuChanged && utilChanged ? (
          <span className="text-xs font-medium text-amber-400">Moved + adjusted</span>
        ) : gpuChanged ? (
          <span className="text-xs font-medium text-emerald-400">Moved</span>
        ) : (
          <span className="text-xs font-medium text-amber-400">Util adjusted</span>
        )}
      </div>
    </div>
  );
}

interface RepackPanelProps {
  result: RepackResult;
  applying: boolean;
  onApply: () => void;
  onBack: () => void;
}

function RepackPanel({ result, applying, onApply, onBack }: RepackPanelProps) {
  const changed = result.assignments.filter(
    (a) => a.status !== "unchanged" && a.status !== "already_running"
  );

  return (
    <div className="border border-emerald-500/30 bg-slate-900/70 rounded-xl px-4 py-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-white">Recommended allocation</p>
          <p className="text-xs text-slate-500 mt-0.5">
            Largest models placed into largest free GPU spaces first
          </p>
        </div>
        <div className="flex gap-2 flex-shrink-0 flex-wrap justify-end">
          {result.solvable ? (
            <span className="text-xs font-medium text-emerald-400 bg-emerald-900/30 border border-emerald-800 rounded-full px-2 py-0.5">
              All models fit
            </span>
          ) : (
            <span className="text-xs font-medium text-red-400 bg-red-900/30 border border-red-800 rounded-full px-2 py-0.5">
              {result.unsolvable.length} won&apos;t fit
            </span>
          )}
          {changed.length > 0 && (
            <span className="text-xs font-medium text-amber-400 bg-amber-900/30 border border-amber-800 rounded-full px-2 py-0.5">
              {changed.length} reassigned
            </span>
          )}
        </div>
      </div>

      {changed.length === 0 && result.solvable && (
        <p className="text-xs text-slate-400 bg-slate-800/60 rounded-lg px-3 py-2">
          No changes needed — the current assignment already fits given available VRAM.
        </p>
      )}

      {result.assignments.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-slate-500 font-medium uppercase tracking-wider">Placement plan</p>
          {result.assignments.map((a) => <RepackRow key={a.port} a={a} />)}
        </div>
      )}

      {result.unsolvable.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-red-400 font-medium uppercase tracking-wider">Cannot place</p>
          <div className="bg-red-900/20 border border-red-800 rounded-lg px-3 py-2.5 space-y-1.5">
            {result.unsolvable.map((u) => (
              <div key={u.port} className="flex items-center justify-between text-xs">
                <span className="text-red-300 font-medium">{u.served_name}</span>
                <span className="text-red-400">{u.required_gb} GB required — no GPU has enough free VRAM</span>
              </div>
            ))}
          </div>
          <p className="text-xs text-slate-500">
            To fit these models, stop other running instances to free VRAM, or add a GPU.
          </p>
        </div>
      )}

      {changed.length > 0 && result.solvable && (
        <p className="text-xs text-slate-500">
          Applying will save these assignments to the config, then launch all models.
        </p>
      )}

      <div className="flex gap-2 justify-end">
        <button onClick={onBack} disabled={applying} className="px-3 py-1.5 text-sm text-slate-400 hover:text-white transition-colors disabled:opacity-40">
          Back
        </button>
        <button
          onClick={onApply}
          disabled={applying || !result.solvable}
          className="px-4 py-1.5 text-sm rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white disabled:opacity-50 transition-colors"
          title={!result.solvable ? "Some models cannot be placed — free VRAM on more GPUs first" : ""}
        >
          {applying ? "Applying…" : "Apply & Activate"}
        </button>
      </div>
    </div>
  );
}

interface PreflightPanelProps {
  configName: string;
  result: PreflightResult;
  activating: boolean;
  repacking: boolean;
  repackResult: RepackResult | null;
  applying: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onMakeFit: () => void;
  onApplyRepack: () => void;
  onBackFromRepack: () => void;
}

function PreflightPanel({
  configName, result, activating, repacking, repackResult, applying,
  onConfirm, onCancel, onMakeFit, onApplyRepack, onBackFromRepack,
}: PreflightPanelProps) {
  if (repackResult) {
    return (
      <RepackPanel
        result={repackResult}
        applying={applying}
        onApply={onApplyRepack}
        onBack={onBackFromRepack}
      />
    );
  }

  return (
    <div className="border border-blue-500/30 bg-slate-900/70 rounded-xl px-4 py-4 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold text-white">Allocation check — {configName}</p>
          <p className="text-xs text-slate-500 mt-0.5">Based on current free VRAM across GPUs</p>
        </div>
        {result.all_fit ? (
          <span className="text-xs font-medium text-emerald-400 bg-emerald-900/30 border border-emerald-800 rounded-full px-2 py-0.5">
            All clear
          </span>
        ) : (
          <span className="text-xs font-medium text-amber-400 bg-amber-900/30 border border-amber-800 rounded-full px-2 py-0.5">
            Warnings
          </span>
        )}
      </div>

      <div className="space-y-2">
        {result.checks.map((c) => <CheckRow key={c.port} c={c} />)}
      </div>

      {!result.all_fit && (
        <p className="text-xs text-amber-400 bg-amber-900/20 border border-amber-800 rounded-lg px-3 py-2">
          Some models may fail to start due to insufficient VRAM. Use &ldquo;Smart allocate&rdquo; to find
          the best placement automatically.
        </p>
      )}

      <div className="flex gap-2 justify-end flex-wrap">
        <button onClick={onCancel} disabled={activating || repacking} className="px-3 py-1.5 text-sm text-slate-400 hover:text-white transition-colors disabled:opacity-40">
          Cancel
        </button>
        <button
          onClick={onMakeFit}
          disabled={activating || repacking}
          className="px-4 py-1.5 text-sm rounded-lg bg-blue-700 hover:bg-blue-600 text-white disabled:opacity-50 transition-colors"
        >
          {repacking ? "Calculating…" : "Smart allocate"}
        </button>
        <button
          onClick={onConfirm}
          disabled={activating || repacking}
          className={`px-4 py-1.5 text-sm rounded-lg text-white disabled:opacity-50 transition-colors ${
            result.all_fit ? "bg-emerald-700 hover:bg-emerald-600" : "bg-amber-700 hover:bg-amber-600"
          }`}
        >
          {activating ? "Launching…" : result.all_fit ? "Activate" : "Activate anyway"}
        </button>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function StackConfigs({ node, onRefresh }: Props) {
  const [configs, setConfigs]           = useState<StackConfig[]>([]);
  const [loading, setLoading]           = useState(true);
  const [busy, setBusy]                 = useState<string | null>(null);
  const [error, setError]               = useState<string | null>(null);
  const [snapshotName, setSnapshotName] = useState("");
  const [showSnapshot, setShowSnapshot] = useState(false);

  // Preflight state
  const [preflightFor, setPreflightFor]       = useState<string | null>(null);
  const [preflightResult, setPreflightResult] = useState<PreflightResult | null>(null);
  const [preflighting, setPreflighting]       = useState(false);
  const [activating, setActivating]           = useState(false);

  // Repack state
  const [repackResult, setRepackResult]   = useState<RepackResult | null>(null);
  const [repacking, setRepacking]         = useState(false);
  const [applying, setApplying]           = useState(false);
  const [directRepackFor, setDirectRepackFor] = useState<string | null>(null);

  const api = createNodeApi(node);

  const refresh = useCallback(async () => {
    try {
      const data = await api.configs();
      setConfigs(data);
    } catch {
      // silently ignore
    } finally {
      setLoading(false);
    }
  }, [node]);  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { refresh(); }, [refresh]);

  async function handleActivateClick(name: string) {
    setError(null);
    setPreflighting(true);
    setPreflightFor(name);
    setPreflightResult(null);
    try {
      const result = await api.preflightConfig(name);
      setPreflightResult(result);
    } catch (e) {
      setError(String(e));
      setPreflightFor(null);
    } finally {
      setPreflighting(false);
    }
  }

  async function handleActivateConfirm() {
    if (!preflightFor) return;
    setActivating(true);
    setError(null);
    try {
      await api.activateConfig(preflightFor);
      setPreflightFor(null);
      setPreflightResult(null);
      setRepackResult(null);
      await refresh();
      onRefresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setActivating(false);
    }
  }

  async function handleMakeFit() {
    if (!preflightFor) return;
    setRepacking(true);
    setError(null);
    try {
      const result = await api.repackConfig(preflightFor);
      setRepackResult(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setRepacking(false);
    }
  }

  async function handleSmartAllocate(name: string) {
    setError(null);
    setPreflightFor(null);
    setPreflightResult(null);
    setRepackResult(null);
    setDirectRepackFor(name);
    setRepacking(true);
    try {
      const result = await api.repackConfig(name);
      setRepackResult(result);
    } catch (e) {
      setError(String(e));
      setDirectRepackFor(null);
    } finally {
      setRepacking(false);
    }
  }

  async function handleApplyRepack() {
    const configName = preflightFor ?? directRepackFor;
    if (!configName || !repackResult) return;
    setApplying(true);
    setError(null);
    try {
      await api.applyRepack(configName, repackResult.assignments);
      setPreflightFor(null);
      setPreflightResult(null);
      setRepackResult(null);
      setDirectRepackFor(null);
      await refresh();
      onRefresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setApplying(false);
    }
  }

  function handleBackFromRepack() {
    setRepackResult(null);
    if (directRepackFor && !preflightFor) {
      setDirectRepackFor(null);
    }
  }

  async function deactivate(name: string) {
    setBusy(name + ":deactivate");
    setError(null);
    try {
      await api.deactivateConfig(name);
      await refresh();
      onRefresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function deleteConfig(name: string) {
    if (!confirm(`Delete stack config "${name}"?`)) return;
    setBusy(name + ":delete");
    setError(null);
    try {
      await api.deleteConfig(name);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function handleSnapshot(e: React.FormEvent) {
    e.preventDefault();
    const name = snapshotName.trim() || "Snapshot";
    setBusy("snapshot");
    setError(null);
    try {
      await api.snapshotConfig(name, "Saved from running instances");
      setSnapshotName("");
      setShowSnapshot(false);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <h2 className="text-sm font-semibold text-white">Stack Templates</h2>
        <button
          onClick={() => setShowSnapshot((v) => !v)}
          className="text-xs px-3 py-1 rounded border border-border text-slate-400 hover:text-white hover:border-slate-500 transition-colors"
        >
          + Snapshot current
        </button>
      </div>

      {showSnapshot && (
        <form onSubmit={handleSnapshot} className="px-4 py-3 border-b border-border bg-slate-900/50 flex gap-2">
          <input
            type="text"
            value={snapshotName}
            placeholder="Config name (e.g. My Setup)"
            onChange={(e) => setSnapshotName(e.target.value)}
            className="flex-1 bg-slate-800 border border-border rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500 placeholder-slate-600"
          />
          <button
            type="submit"
            disabled={busy === "snapshot"}
            className="px-3 py-1.5 text-sm rounded-lg bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50 transition-colors"
          >
            {busy === "snapshot" ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            onClick={() => setShowSnapshot(false)}
            className="px-3 py-1.5 text-sm text-slate-400 hover:text-white transition-colors"
          >
            Cancel
          </button>
        </form>
      )}

      {loading ? (
        <p className="px-4 py-6 text-sm text-slate-500 text-center">Loading…</p>
      ) : configs.length === 0 ? (
        <p className="px-4 py-6 text-sm text-slate-500 text-center">
          No stack configs. Use &ldquo;Snapshot current&rdquo; to save the running setup.
        </p>
      ) : (
        <div className="divide-y divide-border">
          {configs.map((cfg) => {
            const allRunning       = cfg.running_count === cfg.total_count && cfg.total_count! > 0;
            const someRunning      = (cfg.running_count ?? 0) > 0 && !allRunning;
            const isBusy           = busy?.startsWith(cfg.name);
            const isPreflight      = preflightFor === cfg.name;
            const isDirectRepack   = directRepackFor === cfg.name;
            const isExpanded       = isPreflight || isDirectRepack;

            return (
              <div key={cfg.name}>
                {/* Config row */}
                <div className="px-4 py-3 flex items-start gap-4">
                  <div className="mt-1">
                    <span className={`w-2 h-2 rounded-full inline-block ${
                      allRunning  ? "bg-emerald-400" :
                      someRunning ? "bg-amber-400 animate-pulse" :
                                    "bg-slate-600"
                    }`} />
                  </div>

                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-white leading-tight">{cfg.name}</p>
                    {cfg.description && (
                      <p className="text-xs text-slate-500 mt-0.5 truncate">{cfg.description}</p>
                    )}
                    <div className="flex flex-wrap gap-x-3 mt-1">
                      <span className="text-xs text-slate-500">
                        {cfg.total_count} model{cfg.total_count !== 1 ? "s" : ""}
                      </span>
                      <span className={`text-xs ${allRunning ? "text-emerald-400" : someRunning ? "text-amber-400" : "text-slate-600"}`}>
                        {cfg.running_count}/{cfg.total_count} running
                      </span>
                      {cfg.models.map((m) => (
                        <span key={m.port} className="text-xs text-slate-600 font-mono">
                          :{m.port} {m.served_name}
                        </span>
                      ))}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button
                      onClick={() => handleSmartAllocate(cfg.name)}
                      disabled={!!isBusy || !!preflightFor || !!directRepackFor}
                      className="text-xs px-3 py-1 rounded bg-blue-900/40 text-blue-300 hover:bg-blue-800/60 disabled:opacity-40 transition-colors"
                      title="Calculate optimal GPU allocation for this config"
                    >
                      {isDirectRepack && repacking ? "Calculating…" : "Smart allocate"}
                    </button>
                    {allRunning ? (
                      <button
                        onClick={() => deactivate(cfg.name)}
                        disabled={!!isBusy || !!isExpanded}
                        className="text-xs px-3 py-1 rounded bg-amber-900/40 text-amber-300 hover:bg-amber-800/60 disabled:opacity-40 transition-colors"
                      >
                        {busy === cfg.name + ":deactivate" ? "Stopping…" : "Deactivate"}
                      </button>
                    ) : (
                      <button
                        onClick={() => handleActivateClick(cfg.name)}
                        disabled={!!isBusy || !!isExpanded}
                        className="text-xs px-3 py-1 rounded bg-emerald-900/40 text-emerald-300 hover:bg-emerald-800/60 disabled:opacity-40 transition-colors"
                      >
                        {isPreflight && preflighting ? "Checking…" : "Activate"}
                      </button>
                    )}
                    <button
                      onClick={() => deleteConfig(cfg.name)}
                      disabled={!!isBusy || !!isExpanded}
                      className="text-xs px-2 py-1 rounded text-slate-600 hover:text-red-400 disabled:opacity-40 transition-colors"
                      title="Delete config"
                    >
                      ✕
                    </button>
                  </div>
                </div>

                {/* Preflight panel — inline below the config row */}
                {isPreflight && preflightResult && (
                  <div className="px-4 pb-4">
                    <PreflightPanel
                      configName={cfg.name}
                      result={preflightResult}
                      activating={activating}
                      repacking={repacking}
                      repackResult={repackResult}
                      applying={applying}
                      onConfirm={handleActivateConfirm}
                      onCancel={() => { setPreflightFor(null); setPreflightResult(null); setRepackResult(null); }}
                      onMakeFit={handleMakeFit}
                      onApplyRepack={handleApplyRepack}
                      onBackFromRepack={handleBackFromRepack}
                    />
                  </div>
                )}

                {/* Direct smart-allocate panel — shown when triggered from config row */}
                {isDirectRepack && !isPreflight && repackResult && (
                  <div className="px-4 pb-4">
                    <RepackPanel
                      result={repackResult}
                      applying={applying}
                      onApply={handleApplyRepack}
                      onBack={() => { setRepackResult(null); setDirectRepackFor(null); }}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {error && (
        <p className="px-4 py-2 text-xs text-red-400 bg-red-900/20 border-t border-red-800">{error}</p>
      )}
    </div>
  );
}
