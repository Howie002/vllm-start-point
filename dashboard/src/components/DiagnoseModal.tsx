"use client";

import { useEffect, useState } from "react";
import type { NodeConfig, DiagnoseResult } from "@/lib/types";
import { createNodeApi } from "@/lib/api";

interface Props {
  node: NodeConfig;
  onClose: () => void;
}

function bytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (n >= 1024 * 1024)        return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024)               return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function age(mtimeSec: number): string {
  const dt = Date.now() / 1000 - mtimeSec;
  if (dt < 60)        return `${Math.round(dt)}s ago`;
  if (dt < 3600)      return `${Math.round(dt / 60)}m ago`;
  if (dt < 86400)     return `${Math.round(dt / 3600)}h ago`;
  return `${Math.round(dt / 86400)}d ago`;
}

export function DiagnoseModal({ node, onClose }: Props) {
  const [data, setData]       = useState<DiagnoseResult | null>(null);
  const [error, setError]     = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await createNodeApi(node).diagnose();
      setData(res);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [node]);

  const unownedCount =
    (data?.unowned_gpu_compute_apps.length ?? 0) +
    (data?.reparented_python.length ?? 0);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-2xl w-full max-w-4xl mx-4 shadow-2xl flex flex-col max-h-[90vh]"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-border flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-white font-semibold truncate">Diagnose · {node.name}</h2>
            <p className="text-xs text-slate-500 mt-0.5 font-mono truncate">
              {node.ip}:{node.agent_port}
              {data && (
                <span className={`ml-2 ${unownedCount > 0 ? "text-amber-400" : "text-emerald-400"}`}>
                  · {unownedCount === 0 ? "no unowned allocations" : `${unownedCount} unowned`}
                </span>
              )}
            </p>
          </div>
          <div className="flex items-center gap-3 flex-shrink-0">
            <button
              onClick={load}
              disabled={loading}
              className="text-xs px-2 py-1 rounded text-slate-400 hover:text-cyan-400 hover:bg-slate-700/50 disabled:opacity-40 transition-colors"
            >
              {loading ? "Scanning…" : "Re-scan"}
            </button>
            <button onClick={onClose} className="text-slate-500 hover:text-white text-lg leading-none">✕</button>
          </div>
        </div>

        <div className="flex-1 overflow-auto p-6 space-y-6">
          {error && (
            <div className="text-xs text-red-400 bg-red-900/20 border border-red-800 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          {loading && !data && (
            <div className="text-xs text-slate-500">Running nvidia-smi, scanning processes, reading /dev/shm…</div>
          )}

          {data && (
            <>
              <Section
                title="Unowned GPU compute apps"
                hint="Processes using GPU memory that the agent's instance list doesn't know about. The actionable signal during a RAM spike."
                tone={data.unowned_gpu_compute_apps.length > 0 ? "warn" : "ok"}
                count={data.unowned_gpu_compute_apps.length}
              >
                {data.unowned_gpu_compute_apps.length === 0 ? (
                  <p className="text-xs text-slate-500">None — every GPU allocation is owned by a tracked instance.</p>
                ) : (
                  <table className="w-full text-xs font-mono">
                    <thead className="text-slate-500">
                      <tr><th className="text-left pb-1">PID</th><th className="text-left pb-1">Process</th><th className="text-right pb-1">VRAM</th></tr>
                    </thead>
                    <tbody className="text-slate-300">
                      {data.unowned_gpu_compute_apps.map(a => (
                        <tr key={a.pid} className="border-t border-slate-800">
                          <td className="py-1">{a.pid}</td>
                          <td className="py-1 truncate max-w-md">{a.name}</td>
                          <td className="py-1 text-right">{a.vram_mb != null ? `${a.vram_mb} MB` : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Section>

              <Section
                title="Reparented Python / vLLM processes (PPID = 1)"
                hint="Children that survived their parent — typically tensor-parallel workers left behind after a hard agent kill. `./node.sh stop` won't reach these."
                tone={data.reparented_python.length > 0 ? "warn" : "ok"}
                count={data.reparented_python.length}
              >
                {data.reparented_python.length === 0 ? (
                  <p className="text-xs text-slate-500">None — no orphaned vLLM workers.</p>
                ) : (
                  <table className="w-full text-xs font-mono">
                    <thead className="text-slate-500">
                      <tr><th className="text-left pb-1">PID</th><th className="text-right pb-1">RSS</th><th className="text-left pb-1 pl-3">Command</th></tr>
                    </thead>
                    <tbody className="text-slate-300">
                      {data.reparented_python.map(p => (
                        <tr key={p.pid} className="border-t border-slate-800">
                          <td className="py-1">{p.pid}</td>
                          <td className="py-1 text-right">{p.rss_mb != null ? `${p.rss_mb} MB` : "—"}</td>
                          <td className="py-1 pl-3 break-all">{p.cmd}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Section>

              <Section
                title="/dev/shm segments"
                hint="vLLM uses /dev/shm for KV-cache and IPC. Leftover segments after a crash count as system RAM on unified-memory hardware (DGX Spark)."
                tone="info"
                count={data.dev_shm.length}
              >
                {data.dev_shm.length === 0 ? (
                  <p className="text-xs text-slate-500">/dev/shm is empty.</p>
                ) : (
                  <table className="w-full text-xs font-mono">
                    <thead className="text-slate-500">
                      <tr><th className="text-left pb-1">Name</th><th className="text-right pb-1">Size</th><th className="text-right pb-1">Modified</th></tr>
                    </thead>
                    <tbody className="text-slate-300">
                      {data.dev_shm.slice(0, 30).map(s => (
                        <tr key={s.name} className="border-t border-slate-800">
                          <td className="py-1 truncate max-w-md">{s.name}</td>
                          <td className="py-1 text-right">{bytes(s.size_bytes)}</td>
                          <td className="py-1 text-right text-slate-500">{age(s.mtime)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {data.dev_shm.length > 30 && (
                  <p className="text-[11px] text-slate-600 mt-1">…and {data.dev_shm.length - 30} more</p>
                )}
              </Section>

              <Section
                title="SysV shared memory (ipcs -m)"
                hint="Older IPC mechanism. Almost always empty in a clean state."
                tone="info"
                count={data.sysv_shm.length}
              >
                {data.sysv_shm.length === 0 ? (
                  <p className="text-xs text-slate-500">None.</p>
                ) : (
                  <table className="w-full text-xs font-mono">
                    <thead className="text-slate-500">
                      <tr>
                        <th className="text-left pb-1">Key</th>
                        <th className="text-left pb-1">Owner</th>
                        <th className="text-right pb-1">Bytes</th>
                        <th className="text-right pb-1">Attached</th>
                      </tr>
                    </thead>
                    <tbody className="text-slate-300">
                      {data.sysv_shm.map(s => (
                        <tr key={s.shmid} className="border-t border-slate-800">
                          <td className="py-1">{s.key}</td>
                          <td className="py-1">{s.owner}</td>
                          <td className="py-1 text-right">{bytes(s.bytes)}</td>
                          <td className={`py-1 text-right ${s.nattch === 0 ? "text-amber-400" : ""}`}>{s.nattch}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Section>

              <Section
                title="Agent-tracked instances"
                hint="What /status sees. PIDs here are the ones cross-referenced against GPU compute apps above."
                tone="info"
                count={data.tracked_instances.length}
              >
                {data.tracked_instances.length === 0 ? (
                  <p className="text-xs text-slate-500">Agent reports no running vLLM instances.</p>
                ) : (
                  <table className="w-full text-xs font-mono">
                    <thead className="text-slate-500">
                      <tr>
                        <th className="text-left pb-1">Port</th>
                        <th className="text-left pb-1">PID</th>
                        <th className="text-left pb-1">Served</th>
                        <th className="text-left pb-1">GPU</th>
                        <th className="text-left pb-1">Status</th>
                      </tr>
                    </thead>
                    <tbody className="text-slate-300">
                      {data.tracked_instances.map(i => (
                        <tr key={i.port} className="border-t border-slate-800">
                          <td className="py-1">{i.port}</td>
                          <td className="py-1">{i.pid}</td>
                          <td className="py-1 truncate max-w-xs">{i.served_name ?? "—"}</td>
                          <td className="py-1">{i.gpu_index ?? "—"}</td>
                          <td className="py-1">{i.status}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Section>

              {data.warnings.length > 0 && (
                <Section title="Warnings" hint="Subsystems that couldn't be queried — partial results above." tone="warn" count={data.warnings.length}>
                  <ul className="text-xs text-amber-300 list-disc pl-5 space-y-0.5">
                    {data.warnings.map((w, i) => <li key={i}>{w}</li>)}
                  </ul>
                </Section>
              )}
            </>
          )}
        </div>

        <div className="px-6 py-2.5 border-t border-border text-[11px] text-slate-500">
          Forensic snapshot — does not modify state. See ROADMAP "No way to forensically diagnose orphaned vLLM workers…".
        </div>
      </div>
    </div>
  );
}

function Section({
  title, hint, children, count, tone,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
  count: number;
  tone: "ok" | "warn" | "info";
}) {
  const dotColor = tone === "warn" ? "bg-amber-400" : tone === "ok" ? "bg-emerald-400" : "bg-slate-600";
  return (
    <section>
      <div className="flex items-center gap-2 mb-1">
        <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
        <h3 className="text-sm font-semibold text-white">{title}</h3>
        <span className="text-xs text-slate-500">({count})</span>
      </div>
      <p className="text-[11px] text-slate-500 mb-2">{hint}</p>
      <div className="bg-slate-900/60 border border-border rounded-lg p-3">
        {children}
      </div>
    </section>
  );
}
