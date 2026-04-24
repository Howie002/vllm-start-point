"use client";

import { useState, useRef, useCallback } from "react";
import type { ClusterNodeStatus } from "@/lib/types";
import { TEST_PLOTS } from "@/lib/test-plots";

interface Props {
  nodeStatuses: ClusterNodeStatus[];
}

interface TestResult {
  idx: number;
  prompt: string;
  model: string;
  backend: string | null;
  elapsed: number;
  tokens: number;
  text: string;
  error: string | null;
}

interface Summary {
  wallMs: number;
  serialMs: number;
  backendCounts: Record<string, number>;
  modelCounts: Record<string, number>;
  errorCount: number;
  maxSimilarity: number;
}

type PresetId = "connectivity" | "story15" | "story100" | "custom";

const PRESETS: {
  id: PresetId;
  label: string;
  badge: string;
  description: string;
  n: number;
  maxTokens: number;
  temperature: number;
  buildPrompts: (n: number, custom?: string) => string[];
}[] = [
  {
    id: "connectivity",
    label: "Connectivity",
    badge: "8 req",
    description: "Quick sanity check — verifies all backends respond and measures baseline latency.",
    n: 8,
    maxTokens: 20,
    temperature: 0,
    buildPrompts: () => Array(8).fill("Reply with exactly two words: Hello world"),
  },
  {
    id: "story15",
    label: "Story Burst",
    badge: "15 req",
    description: "15 concurrent stories with unique plots. Confirms parallelism, load balancing, and response quality.",
    n: 15,
    maxTokens: 220,
    temperature: 0.85,
    buildPrompts: (n) =>
      TEST_PLOTS.slice(0, n).map(
        (p) => `Write a short story (80–120 words). Plot: ${p}. Just write the story.`
      ),
  },
  {
    id: "story100",
    label: "Story Stress",
    badge: "100 req",
    description: "Full 100-request cluster load test. Measures throughput, distribution, and uniqueness across all backends.",
    n: 100,
    maxTokens: 220,
    temperature: 0.85,
    buildPrompts: (n) =>
      TEST_PLOTS.slice(0, n).map(
        (p) => `Write a short story (80–120 words). Plot: ${p}. Just write the story.`
      ),
  },
  {
    id: "custom",
    label: "Custom",
    badge: "you pick",
    description: "Define your own prompt and concurrency. Use {n} in the prompt to vary requests.",
    n: 0,
    maxTokens: 300,
    temperature: 0.7,
    buildPrompts: (n, custom = "") =>
      Array.from({ length: n }, (_, i) =>
        custom.replace(/\{n\}/g, String(i + 1))
      ),
  },
];

// Distinct colours for model badges — cycles if > 6 models
const MODEL_COLORS = [
  "bg-cyan-900/50 text-cyan-300",
  "bg-violet-900/50 text-violet-300",
  "bg-amber-900/50 text-amber-300",
  "bg-emerald-900/50 text-emerald-300",
  "bg-pink-900/50 text-pink-300",
  "bg-sky-900/50 text-sky-300",
];

function modelColor(model: string, allModels: string[]): string {
  const idx = allModels.indexOf(model);
  return MODEL_COLORS[(idx < 0 ? 0 : idx) % MODEL_COLORS.length];
}

function shortModelName(model: string): string {
  return model.length > 28 ? model.slice(0, 26) + "…" : model;
}

function jaccardSimilarity(a: string, b: string): number {
  const wa = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const wb = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / (wa.size + wb.size - inter || 1);
}

function maxSimilarity(texts: string[]): number {
  let max = 0;
  for (let i = 0; i < texts.length; i++)
    for (let j = i + 1; j < texts.length; j++) {
      const s = jaccardSimilarity(texts[i], texts[j]);
      if (s > max) max = s;
    }
  return max;
}

function nodeLabel(backend: string | null, nodeStatuses: ClusterNodeStatus[]): string {
  if (!backend) return "unknown";
  const ip = backend.match(/\/\/([^:]+)/)?.[1] ?? "";
  const ns = nodeStatuses.find((n) => n.node.ip === ip);
  return ns?.node.name ?? ip;
}

function backendShort(backend: string | null): string {
  if (!backend) return "?";
  return backend.replace(/^https?:\/\//, "").replace(/\/v1\/?$/, "");
}

export function TestingView({ nodeStatuses }: Props) {
  const [preset, setPreset] = useState<PresetId>("connectivity");
  const [customPrompt, setCustomPrompt] = useState(
    "Write a haiku about the number {n}."
  );
  const [customN, setCustomN] = useState(10);
  const [customMaxTokens, setCustomMaxTokens] = useState(80);
  const [customTemp, setCustomTemp] = useState(0.7);

  // null = "all models selected"; string[] = explicit subset
  const [selectedModels, setSelectedModels] = useState<string[] | null>(null);

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [total, setTotal] = useState(0);
  const [results, setResults] = useState<TestResult[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Derive proxy URL and model list from node statuses
  const proxyUrl = nodeStatuses.find((ns) => ns.status?.proxy?.url)?.status?.proxy?.url ?? "";
  const proxyModels = nodeStatuses.find((ns) => (ns.status?.proxy?.models?.length ?? 0) > 0)
    ?.status?.proxy?.models ?? [];

  // Effective models to test — null means use all
  const effectiveModels = selectedModels ?? proxyModels;

  const toggleModel = (m: string) => {
    const current = selectedModels ?? proxyModels;
    if (current.includes(m)) {
      const next = current.filter((x) => x !== m);
      setSelectedModels(next.length === 0 ? [m] : next); // keep at least one
    } else {
      setSelectedModels([...current, m]);
    }
  };

  const activePreset = PRESETS.find((p) => p.id === preset)!;

  const run = useCallback(async () => {
    if (!proxyUrl || effectiveModels.length === 0) return;

    const p = PRESETS.find((p) => p.id === preset)!;
    const n = preset === "custom" ? customN : p.n;
    const prompts = p.buildPrompts(n, customPrompt);
    const maxTokens = preset === "custom" ? customMaxTokens : p.maxTokens;
    const temperature = preset === "custom" ? customTemp : p.temperature;

    setRunning(true);
    setProgress(0);
    setTotal(prompts.length);
    setResults([]);
    setSummary(null);
    setExpandedIdx(null);

    const abort = new AbortController();
    abortRef.current = abort;

    const allResults: TestResult[] = [];
    let wallMs = 0;

    try {
      const res = await fetch("/api/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proxyUrl, models: effectiveModels, prompts, maxTokens, temperature }),
        signal: abort.signal,
      });

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const evt = JSON.parse(line.slice(6));
          if (evt.done) {
            wallMs = evt.wallMs;
            continue;
          }
          const result: TestResult = { ...evt, prompt: prompts[evt.idx] };
          allResults.push(result);
          setProgress((v) => v + 1);
          setResults((prev) =>
            [...prev, result].sort((a, b) => a.idx - b.idx)
          );
        }
      }

      const errorCount = allResults.filter((r) => r.error).length;
      const texts = allResults.filter((r) => !r.error).map((r) => r.text);
      const backendCounts: Record<string, number> = {};
      const modelCounts: Record<string, number> = {};
      for (const r of allResults) {
        const bk = r.backend ?? "unknown";
        backendCounts[bk] = (backendCounts[bk] ?? 0) + 1;
        const mk = r.model ?? "unknown";
        modelCounts[mk] = (modelCounts[mk] ?? 0) + 1;
      }
      const serialMs = allResults.reduce((s, r) => s + r.elapsed, 0);

      setSummary({
        wallMs,
        serialMs,
        backendCounts,
        modelCounts,
        errorCount,
        maxSimilarity: texts.length > 1 ? maxSimilarity(texts) : 0,
      });
    } catch (e) {
      if ((e as Error).name !== "AbortError") console.error(e);
    } finally {
      setRunning(false);
    }
  }, [preset, proxyUrl, effectiveModels, customPrompt, customN, customMaxTokens, customTemp]);

  const stop = () => {
    abortRef.current?.abort();
    setRunning(false);
  };

  const totalForPreset = preset === "custom" ? customN : activePreset.n;
  const multiModel = effectiveModels.length > 1;

  return (
    <div className="space-y-4">

      {/* Preset cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            onClick={() => { setPreset(p.id); setSummary(null); setResults([]); }}
            className={`text-left p-3 rounded-xl border transition-colors ${
              preset === p.id
                ? "border-cyan-500 bg-cyan-950/30"
                : "border-border hover:border-slate-600 bg-card"
            }`}
          >
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-semibold text-white">{p.label}</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-300">{p.badge}</span>
            </div>
            <p className="text-[11px] text-slate-400 leading-snug">{p.description}</p>
          </button>
        ))}
      </div>

      {/* Config row */}
      <div className="bg-card border border-border rounded-xl px-4 py-3 flex flex-wrap items-start gap-4">

        {/* Model selection */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <label className="text-[10px] text-slate-500 uppercase tracking-wider">Models</label>
            {proxyModels.length > 1 && (
              <button
                onClick={() => setSelectedModels(null)}
                className="text-[10px] text-slate-600 hover:text-slate-400 transition-colors"
              >
                select all
              </button>
            )}
          </div>
          {proxyModels.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {proxyModels.map((m) => {
                const checked = (selectedModels ?? proxyModels).includes(m);
                return (
                  <label
                    key={m}
                    className={`flex items-center gap-1.5 px-2 py-1 rounded-lg border cursor-pointer transition-colors text-[11px] ${
                      checked
                        ? "border-cyan-600 bg-cyan-950/30 text-white"
                        : "border-border text-slate-500 hover:border-slate-600"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleModel(m)}
                      className="accent-cyan-500 w-3 h-3"
                    />
                    {shortModelName(m)}
                  </label>
                );
              })}
            </div>
          ) : (
            <span className="text-xs text-red-400">No proxy models — start a vLLM instance first</span>
          )}
          {multiModel && (
            <p className="text-[10px] text-slate-500">
              {effectiveModels.length} models · requests distributed round-robin
            </p>
          )}
        </div>

        {/* Custom-only fields */}
        {preset === "custom" && (
          <>
            <div className="flex-1 min-w-48 space-y-1">
              <label className="text-[10px] text-slate-500 uppercase tracking-wider">
                Prompt template <span className="normal-case text-slate-600">(use &#123;n&#125; for request index)</span>
              </label>
              <textarea
                value={customPrompt}
                onChange={(e) => setCustomPrompt(e.target.value)}
                rows={2}
                className="w-full text-xs bg-slate-800 border border-border rounded-lg px-2 py-1.5 text-white resize-none"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] text-slate-500 uppercase tracking-wider">Concurrent</label>
              <input
                type="number" min={1} max={100} value={customN}
                onChange={(e) => setCustomN(Math.max(1, Math.min(100, +e.target.value)))}
                className="w-20 text-xs bg-slate-800 border border-border rounded-lg px-2 py-1.5 text-white"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] text-slate-500 uppercase tracking-wider">Max tokens</label>
              <input
                type="number" min={10} max={1000} value={customMaxTokens}
                onChange={(e) => setCustomMaxTokens(+e.target.value)}
                className="w-24 text-xs bg-slate-800 border border-border rounded-lg px-2 py-1.5 text-white"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] text-slate-500 uppercase tracking-wider">Temperature</label>
              <input
                type="number" min={0} max={2} step={0.05} value={customTemp}
                onChange={(e) => setCustomTemp(+e.target.value)}
                className="w-20 text-xs bg-slate-800 border border-border rounded-lg px-2 py-1.5 text-white"
              />
            </div>
          </>
        )}

        {/* Run / Stop */}
        <div className="ml-auto self-end">
          {running ? (
            <button
              onClick={stop}
              className="text-xs px-4 py-2 rounded-lg bg-red-900/40 border border-red-700 text-red-300 hover:bg-red-900/60 transition-colors"
            >
              Stop
            </button>
          ) : (
            <button
              onClick={run}
              disabled={!proxyUrl || effectiveModels.length === 0}
              className="text-xs px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Run {totalForPreset} request{totalForPreset !== 1 ? "s" : ""}
            </button>
          )}
        </div>
      </div>

      {/* Progress */}
      {(running || (results.length > 0 && !summary)) && (
        <div className="space-y-1">
          <div className="flex justify-between text-[11px] text-slate-400">
            <span>{progress} / {total} complete</span>
            {running && <span className="animate-pulse">running…</span>}
          </div>
          <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-cyan-500 rounded-full transition-all duration-300"
              style={{ width: `${total ? (progress / total) * 100 : 0}%` }}
            />
          </div>
        </div>
      )}

      {/* Summary — shown after completion */}
      {summary && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">

          {/* Timing */}
          <div className="bg-card border border-border rounded-xl px-4 py-3 space-y-2">
            <p className="text-xs font-semibold text-white">Timing</p>
            <div className="grid grid-cols-3 gap-2 text-center">
              {[
                { label: "Wall time", val: `${(summary.wallMs / 1000).toFixed(1)}s` },
                { label: "Speedup", val: `${(summary.serialMs / summary.wallMs).toFixed(1)}×` },
                { label: "Avg / req", val: `${(summary.serialMs / results.length / 1000).toFixed(1)}s` },
              ].map(({ label, val }) => (
                <div key={label} className="bg-slate-800/50 rounded-lg py-2">
                  <div className="text-sm font-bold text-cyan-400">{val}</div>
                  <div className="text-[10px] text-slate-500 mt-0.5">{label}</div>
                </div>
              ))}
            </div>
            <div className="flex gap-4 text-[11px] text-slate-400 pt-1">
              <span>Serial est. <span className="text-white">{(summary.serialMs / 1000).toFixed(0)}s</span></span>
              <span>Min <span className="text-white">{(Math.min(...results.map(r => r.elapsed)) / 1000).toFixed(1)}s</span></span>
              <span>Max <span className="text-white">{(Math.max(...results.map(r => r.elapsed)) / 1000).toFixed(1)}s</span></span>
            </div>
          </div>

          {/* Backend distribution */}
          <div className="bg-card border border-border rounded-xl px-4 py-3 space-y-2">
            <p className="text-xs font-semibold text-white">Backend distribution</p>
            <div className="space-y-1.5">
              {Object.entries(summary.backendCounts)
                .sort(([, a], [, b]) => b - a)
                .map(([backend, count]) => {
                  const pct = (count / results.length) * 100;
                  const node = nodeLabel(backend, nodeStatuses);
                  return (
                    <div key={backend} className="flex items-center gap-2 text-[11px]">
                      <span className="w-24 truncate font-medium text-slate-300">{node}</span>
                      <span className="text-slate-600 font-mono text-[10px] w-28 truncate">{backendShort(backend)}</span>
                      <div className="flex-1 bg-slate-800 rounded h-1.5">
                        <div className="bg-cyan-500 h-1.5 rounded transition-all" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-white w-6 text-right">{count}</span>
                    </div>
                  );
                })}
            </div>
            <div className="flex gap-4 text-[11px] pt-1 border-t border-border mt-1">
              <span className={summary.errorCount === 0 ? "text-green-400" : "text-red-400"}>
                {summary.errorCount === 0 ? "✓" : "✗"} {summary.errorCount} error{summary.errorCount !== 1 ? "s" : ""}
              </span>
              <span className={summary.maxSimilarity < 0.4 ? "text-green-400" : "text-amber-400"}>
                {summary.maxSimilarity < 0.4 ? "✓" : "⚠"} max similarity {(summary.maxSimilarity * 100).toFixed(0)}%
              </span>
            </div>
          </div>

          {/* Model distribution */}
          <div className="bg-card border border-border rounded-xl px-4 py-3 space-y-2">
            <p className="text-xs font-semibold text-white">Model distribution</p>
            <div className="space-y-1.5">
              {Object.entries(summary.modelCounts)
                .sort(([, a], [, b]) => b - a)
                .map(([m, count]) => {
                  const pct = (count / results.length) * 100;
                  return (
                    <div key={m} className="flex items-center gap-2 text-[11px]">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 ${modelColor(m, proxyModels)}`}>
                        {shortModelName(m)}
                      </span>
                      <div className="flex-1 bg-slate-800 rounded h-1.5">
                        <div
                          className="h-1.5 rounded transition-all bg-violet-500"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="text-white w-6 text-right shrink-0">{count}</span>
                    </div>
                  );
                })}
            </div>
            {multiModel && (
              <p className="text-[10px] text-slate-600 pt-1 border-t border-border">
                round-robin across {effectiveModels.length} models
              </p>
            )}
          </div>
        </div>
      )}

      {/* Results table */}
      {results.length > 0 && (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <div className="px-4 py-2 border-b border-border flex items-center justify-between">
            <p className="text-xs font-semibold text-white">Results</p>
            <span className="text-[11px] text-slate-500">{results.length} / {total}</span>
          </div>
          <div className="divide-y divide-border max-h-[60vh] overflow-y-auto">
            {results.map((r) => {
              const node = nodeLabel(r.backend, nodeStatuses);
              const short = backendShort(r.backend);
              const expanded = expandedIdx === r.idx;
              return (
                <div
                  key={r.idx}
                  className="px-4 py-2.5 cursor-pointer hover:bg-slate-800/30 transition-colors"
                  onClick={() => setExpandedIdx(expanded ? null : r.idx)}
                >
                  <div className="flex items-start gap-2">
                    {/* Index */}
                    <span className="text-[11px] text-slate-600 font-mono w-8 shrink-0 pt-0.5">
                      {String(r.idx + 1).padStart(3, "0")}
                    </span>

                    {/* Model badge */}
                    {r.model && (
                      <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 font-medium ${
                        r.error ? "bg-red-900/40 text-red-400" : modelColor(r.model, proxyModels)
                      }`}>
                        {r.error ? "error" : shortModelName(r.model)}
                      </span>
                    )}

                    {/* Node badge */}
                    {!r.error && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded shrink-0 bg-slate-700 text-slate-300 font-medium">
                        {node}
                      </span>
                    )}

                    {/* Backend */}
                    <span className="text-[10px] text-slate-600 font-mono shrink-0 hidden sm:inline pt-0.5">
                      {short}
                    </span>

                    {/* Response preview */}
                    <span className={`text-xs flex-1 min-w-0 ${r.error ? "text-red-400" : "text-slate-300"} ${expanded ? "" : "truncate"}`}>
                      {r.error ?? r.text}
                    </span>

                    {/* Stats */}
                    <div className="shrink-0 flex gap-3 text-[10px] text-slate-500 font-mono">
                      <span>{(r.elapsed / 1000).toFixed(1)}s</span>
                      {!r.error && <span>{r.tokens}t</span>}
                    </div>
                  </div>

                  {/* Expanded: full prompt + response */}
                  {expanded && (
                    <div className="mt-2 ml-10 space-y-2">
                      <div className="text-[11px] text-slate-500 bg-slate-800/50 rounded-lg px-3 py-2">
                        <span className="text-slate-600 uppercase text-[10px] tracking-wider block mb-1">Prompt</span>
                        {r.prompt}
                      </div>
                      {!r.error && (
                        <div className="text-[11px] text-slate-300 bg-slate-800/50 rounded-lg px-3 py-2">
                          <span className="text-slate-600 uppercase text-[10px] tracking-wider block mb-1">Response</span>
                          {r.text}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Empty state */}
      {!running && results.length === 0 && (
        <div className="text-center py-12 text-slate-600 text-sm">
          Select a preset and click Run to start a test.
        </div>
      )}
    </div>
  );
}
