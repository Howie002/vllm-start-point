"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import type { NodeConfig, MetricsQueryResult, MetricsGpuBucket, MetricsModelBucket } from "@/lib/types";
import { createNodeApi } from "@/lib/api";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, Legend, CartesianGrid,
  BarChart, Bar,
} from "recharts";

interface Props {
  nodes: NodeConfig[];
}

// Each range has a sensible default resolution. User can override.
const RANGES  = ["1h", "6h", "24h", "7d", "30d"] as const;
const DEFAULT_RES: Record<(typeof RANGES)[number], string> = {
  "1h":  "1m",
  "6h":  "5m",
  "24h": "1h",
  "7d":  "1h",
  "30d": "6h",
};
const RES_OPTIONS = ["1m", "5m", "15m", "1h", "6h", "1d"];
const POLL_MS = 60_000;

// Keyed per-node result so the charts can show "Nano 0 GPU 0" style series.
interface PerNodeMetrics {
  node: NodeConfig;
  data: MetricsQueryResult | null;
  error: string | null;
}

// Combined time-series row keyed by bucket_ts, with dynamic series per node/model.
type Row = { bucket_ts: number; label: string } & Record<string, number | string | null>;

const COLORS = [
  "#22d3ee", "#a78bfa", "#f472b6", "#facc15", "#34d399",
  "#60a5fa", "#f87171", "#fb923c", "#c084fc", "#4ade80",
];

function colorFor(key: string, keys: string[]): string {
  const idx = keys.indexOf(key);
  return COLORS[(idx + COLORS.length) % COLORS.length];
}

// Bucket timestamps come back as epoch seconds. Tooltip wants a human label.
function formatBucket(ts: number, resolution: string): string {
  const d = new Date(ts * 1000);
  if (resolution === "1d" || resolution === "6h") {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
      " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}


export function AnalyticsView({ nodes }: Props) {
  const [range, setRange]           = useState<(typeof RANGES)[number]>("24h");
  const [resolution, setResolution] = useState<string>(DEFAULT_RES["24h"]);
  const [results, setResults]       = useState<PerNodeMetrics[]>([]);
  const [loading, setLoading]       = useState(true);

  // Reset resolution when range changes, unless the user explicitly picked one
  // that still makes sense. Simpler UX: snap to the range's default.
  useEffect(() => {
    setResolution(DEFAULT_RES[range]);
  }, [range]);

  const fetchAll = useCallback(async () => {
    if (nodes.length === 0) return;
    const out: PerNodeMetrics[] = await Promise.all(
      nodes.map(async (node) => {
        try {
          const data = await createNodeApi(node).metrics(range, resolution);
          return { node, data, error: null };
        } catch (e) {
          return { node, data: null, error: String(e) };
        }
      })
    );
    setResults(out);
    setLoading(false);
  }, [nodes, range, resolution]);

  useEffect(() => {
    setLoading(true);
    fetchAll();
    const id = setInterval(fetchAll, POLL_MS);
    return () => clearInterval(id);
  }, [fetchAll]);

  // ── Build chart rows ──────────────────────────────────────────────────────

  // GPU utilization: one row per bucket_ts, series per (node, gpu) = "Nano 0:GPU 0".
  const { utilRows, utilKeys } = useMemo(() => {
    const byTs = new Map<number, Row>();
    const keys = new Set<string>();
    for (const r of results) {
      if (!r.data) continue;
      for (const g of r.data.gpus) {
        if ("_error" in (g as object)) continue;
        const key = `${r.node.name}:GPU ${g.gpu_idx}`;
        keys.add(key);
        const row = byTs.get(g.bucket_ts) ?? { bucket_ts: g.bucket_ts, label: formatBucket(g.bucket_ts, resolution) };
        row[key] = g.util_pct_avg;
        byTs.set(g.bucket_ts, row);
      }
    }
    return {
      utilRows: Array.from(byTs.values()).sort((a, b) => a.bucket_ts - b.bucket_ts),
      utilKeys: Array.from(keys).sort(),
    };
  }, [results, resolution]);

  // Requests per bucket, stacked by served_name (across all nodes).
  const { reqRows, reqKeys } = useMemo(() => {
    const byTs = new Map<number, Row>();
    const keys = new Set<string>();
    for (const r of results) {
      if (!r.data) continue;
      for (const m of r.data.models) {
        if ("_error" in (m as object)) continue;
        keys.add(m.served_name);
        const row = byTs.get(m.bucket_ts) ?? { bucket_ts: m.bucket_ts, label: formatBucket(m.bucket_ts, resolution) };
        row[m.served_name] = ((row[m.served_name] as number) || 0) + (m.requests || 0);
        byTs.set(m.bucket_ts, row);
      }
    }
    return {
      reqRows: Array.from(byTs.values()).sort((a, b) => a.bucket_ts - b.bucket_ts),
      reqKeys: Array.from(keys).sort(),
    };
  }, [results, resolution]);

  // Tokens per bucket: sum prompt+generation across models, two bars.
  const tokenRows = useMemo(() => {
    const byTs = new Map<number, Row>();
    for (const r of results) {
      if (!r.data) continue;
      for (const m of r.data.models) {
        if ("_error" in (m as object)) continue;
        const row = byTs.get(m.bucket_ts) ?? { bucket_ts: m.bucket_ts, label: formatBucket(m.bucket_ts, resolution) };
        row.prompt     = ((row.prompt as number)     || 0) + (m.prompt_tokens || 0);
        row.generation = ((row.generation as number) || 0) + (m.generation_tokens || 0);
        byTs.set(m.bucket_ts, row);
      }
    }
    return Array.from(byTs.values()).sort((a, b) => a.bucket_ts - b.bucket_ts);
  }, [results, resolution]);

  // TTFT p95 line per model.
  const { ttftRows, ttftKeys } = useMemo(() => {
    const byTs = new Map<number, Row>();
    const keys = new Set<string>();
    for (const r of results) {
      if (!r.data) continue;
      for (const m of r.data.models) {
        if ("_error" in (m as object) || m.ttft_p95_ms_avg == null) continue;
        keys.add(m.served_name);
        const row = byTs.get(m.bucket_ts) ?? { bucket_ts: m.bucket_ts, label: formatBucket(m.bucket_ts, resolution) };
        row[m.served_name] = m.ttft_p95_ms_avg;
        byTs.set(m.bucket_ts, row);
      }
    }
    return {
      ttftRows: Array.from(byTs.values()).sort((a, b) => a.bucket_ts - b.bucket_ts),
      ttftKeys: Array.from(keys).sort(),
    };
  }, [results, resolution]);

  // Cluster totals for the top strip.
  const { totalRequests, totalPromptTokens, totalGenTokens, backlogMax } = useMemo(() => {
    let tr = 0, tp = 0, tg = 0, bl = 0;
    for (const r of results) {
      if (!r.data) continue;
      for (const m of r.data.models) {
        if ("_error" in (m as object)) continue;
        tr += m.requests || 0;
        tp += m.prompt_tokens || 0;
        tg += m.generation_tokens || 0;
        if ((m.waiting_max ?? 0) > bl) bl = m.waiting_max ?? 0;
      }
    }
    return { totalRequests: tr, totalPromptTokens: tp, totalGenTokens: tg, backlogMax: bl };
  }, [results]);

  const anyData = utilRows.length > 0 || reqRows.length > 0;

  return (
    <div className="space-y-4">

      {/* ── Range / resolution picker ───────────────────────────────── */}
      <div className="bg-card border border-border rounded-xl px-4 py-3 flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2 text-xs">
          <span className="text-slate-500 uppercase tracking-wider">Range:</span>
          {RANGES.map(r => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`px-2 py-1 rounded text-xs ${
                range === r
                  ? "bg-cyan-900/50 text-cyan-300 border border-cyan-700"
                  : "bg-slate-800 text-slate-400 border border-transparent hover:text-white"
              }`}
            >
              {r}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="text-slate-500 uppercase tracking-wider">Resolution:</span>
          <select
            value={resolution}
            onChange={e => setResolution(e.target.value)}
            className="bg-slate-800 border border-border rounded px-2 py-1 text-slate-200 text-xs"
          >
            {RES_OPTIONS.map(opt => <option key={opt} value={opt}>{opt}</option>)}
          </select>
        </div>
        <div className="flex-1" />
        <span className="text-xs text-slate-500">Auto-refresh every 60s</span>
      </div>

      {/* ── Totals strip ────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <TotalTile label="Requests"   value={totalRequests.toLocaleString()}  sublabel={`in window · ${range}`} />
        <TotalTile label="Prompt tokens" value={formatNum(totalPromptTokens)} sublabel="sum of deltas" />
        <TotalTile label="Generation tokens" value={formatNum(totalGenTokens)} sublabel="sum of deltas" />
        <TotalTile label="Max queue depth" value={backlogMax.toString()} sublabel={backlogMax > 0 ? "requests_waiting peak" : "no backlog"} />
      </div>

      {loading && results.length === 0 && (
        <div className="bg-card border border-border rounded-xl px-4 py-6 text-sm text-slate-400 text-center">
          Loading metrics…
        </div>
      )}

      {!loading && !anyData && (
        <div className="bg-card border border-border rounded-xl px-4 py-6 text-sm text-slate-500 text-center">
          No samples yet in the selected range. The sampler writes every 60s — first bucket appears within 1–2 minutes of agent start.
        </div>
      )}

      {/* ── GPU Utilization ─────────────────────────────────────────── */}
      {utilRows.length > 0 && (
        <ChartCard title="GPU Utilization (%)" subtitle="One line per (node, GPU). Averages within each bucket.">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={utilRows}>
              <CartesianGrid stroke="#1e293b" />
              <XAxis dataKey="label" stroke="#64748b" fontSize={11} />
              <YAxis stroke="#64748b" fontSize={11} domain={[0, 100]} />
              <Tooltip contentStyle={{ backgroundColor: "#0f172a", border: "1px solid #334155" }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {utilKeys.map(k => (
                <Line key={k} type="monotone" dataKey={k} stroke={colorFor(k, utilKeys)} dot={false} strokeWidth={2} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      )}

      {/* ── Requests per bucket (stacked by model) ──────────────────── */}
      {reqRows.length > 0 && (
        <ChartCard title="Requests per bucket" subtitle="Stacked by served model. Delta of request_success_total within each bucket.">
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={reqRows}>
              <CartesianGrid stroke="#1e293b" />
              <XAxis dataKey="label" stroke="#64748b" fontSize={11} />
              <YAxis stroke="#64748b" fontSize={11} />
              <Tooltip contentStyle={{ backgroundColor: "#0f172a", border: "1px solid #334155" }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {reqKeys.map(k => (
                <Bar key={k} dataKey={k} stackId="req" fill={colorFor(k, reqKeys)} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      )}

      {/* ── Tokens per bucket (prompt vs generation) ────────────────── */}
      {tokenRows.length > 0 && (
        <ChartCard title="Tokens per bucket" subtitle="Prompt + generation tokens across all models, summed per bucket.">
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={tokenRows}>
              <CartesianGrid stroke="#1e293b" />
              <XAxis dataKey="label" stroke="#64748b" fontSize={11} />
              <YAxis stroke="#64748b" fontSize={11} />
              <Tooltip contentStyle={{ backgroundColor: "#0f172a", border: "1px solid #334155" }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="prompt"     stackId="tok" fill="#60a5fa" name="prompt" />
              <Bar dataKey="generation" stackId="tok" fill="#22d3ee" name="generation" />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      )}

      {/* ── TTFT p95 per model ──────────────────────────────────────── */}
      {ttftRows.length > 0 && (
        <ChartCard title="Time to First Token — p95 (ms)" subtitle="Approximated from vLLM histogram buckets. Lower is better.">
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={ttftRows}>
              <CartesianGrid stroke="#1e293b" />
              <XAxis dataKey="label" stroke="#64748b" fontSize={11} />
              <YAxis stroke="#64748b" fontSize={11} />
              <Tooltip contentStyle={{ backgroundColor: "#0f172a", border: "1px solid #334155" }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {ttftKeys.map(k => (
                <Line key={k} type="monotone" dataKey={k} stroke={colorFor(k, ttftKeys)} dot={false} strokeWidth={2} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      )}

      {/* ── Per-node errors (only if any node reported one) ─────────── */}
      {results.some(r => r.error) && (
        <div className="bg-red-950/40 border border-red-800 rounded-xl px-4 py-3 text-xs">
          <p className="text-red-300 font-semibold mb-1">Some nodes didn&apos;t respond:</p>
          <ul className="space-y-0.5 text-red-200/80">
            {results.filter(r => r.error).map(r => (
              <li key={r.node.ip} className="font-mono">{r.node.name}: {r.error}</li>
            ))}
          </ul>
        </div>
      )}

    </div>
  );
}


// ── Presentational helpers ────────────────────────────────────────────────────

function ChartCard({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-border">
        <h2 className="text-sm font-semibold text-white">{title}</h2>
        {subtitle && <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>}
      </div>
      <div className="p-3">{children}</div>
    </div>
  );
}

function TotalTile({ label, value, sublabel }: { label: string; value: string; sublabel: string }) {
  return (
    <div className="bg-card border border-border rounded-xl px-4 py-3">
      <p className="text-xs text-slate-500 uppercase tracking-wider">{label}</p>
      <p className="text-xl font-semibold text-white mt-0.5">{value}</p>
      <p className="text-xs text-slate-600 mt-0.5">{sublabel}</p>
    </div>
  );
}

function formatNum(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toString();
}
