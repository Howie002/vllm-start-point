"use client";

import { useEffect, useRef, useState } from "react";
import type { NodeConfig, DynamicLog } from "@/lib/types";
import { createNodeApi } from "@/lib/api";

interface Props {
  node: NodeConfig;
  port: number;
  // Display label so the user knows what this log is for — usually the
  // served_name of the loading instance, or the model name if the launch
  // hasn't been picked up by /status yet.
  label: string;
  onClose: () => void;
}

// Tail length per fetch. 500 lines covers a full vLLM startup trace
// (model load + KV cache init + warmup) without flooding the modal.
const TAIL_LINES = 500;
// Refetch cadence while the modal is open — a launching instance's log
// is actively being written to, so refresh frequently enough that the
// user sees progress without hammering the agent.
const POLL_MS = 2_000;

export function LaunchLogModal({ node, port, label, onClose }: Props) {
  const [log, setLog]         = useState<DynamicLog | null>(null);
  const [error, setError]     = useState<string | null>(null);
  const [autoFollow, setAutoFollow] = useState(true);
  const preRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    let stopped = false;
    async function tick() {
      try {
        const next = await createNodeApi(node).dynamicLog(port, TAIL_LINES);
        if (!stopped) {
          setLog(next);
          setError(null);
        }
      } catch (e) {
        if (!stopped) setError(String(e));
      }
    }
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => { stopped = true; clearInterval(id); };
  }, [node, port]);

  // Auto-scroll to bottom on each refresh while autoFollow is on. A user who
  // scrolls up to read mid-log usually wants to stay there — toggling the
  // checkbox off pins the scroll position so new lines don't yank them away.
  useEffect(() => {
    if (autoFollow && preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
    }
  }, [log, autoFollow]);

  const sizeStr = log
    ? log.size_bytes >= 1024 * 1024
      ? `${(log.size_bytes / 1024 / 1024).toFixed(1)} MB`
      : `${(log.size_bytes / 1024).toFixed(1)} KB`
    : "—";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-card border border-border rounded-2xl w-full max-w-4xl mx-4 shadow-2xl flex flex-col max-h-[90vh]"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-border flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-white font-semibold truncate">Launch log · {label}</h2>
            <p className="text-xs text-slate-500 mt-0.5 font-mono truncate">
              {node.name} · port {port}
              {log && log.exists && ` · ${sizeStr}${log.truncated ? " (tail)" : ""}`}
            </p>
          </div>
          <div className="flex items-center gap-3 flex-shrink-0">
            <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer">
              <input
                type="checkbox"
                checked={autoFollow}
                onChange={e => setAutoFollow(e.target.checked)}
                className="accent-cyan-500 w-3.5 h-3.5"
              />
              Auto-scroll
            </label>
            <button onClick={onClose} className="text-slate-500 hover:text-white text-lg leading-none">✕</button>
          </div>
        </div>

        <div className="flex-1 overflow-hidden bg-slate-950">
          {error ? (
            <div className="p-4 text-xs text-red-400">{error}</div>
          ) : !log ? (
            <div className="p-4 text-xs text-slate-500">Loading…</div>
          ) : !log.exists ? (
            <div className="p-4 text-xs text-slate-500">
              No launch log found at <span className="font-mono">{log.path}</span>.
              {" "}This usually means no instance has been launched on port {port} since the agent started.
            </div>
          ) : log.lines.length === 0 ? (
            <div className="p-4 text-xs text-slate-500">Log is empty.</div>
          ) : (
            <pre
              ref={preRef}
              className="p-4 text-xs font-mono text-slate-200 overflow-auto h-full leading-relaxed whitespace-pre"
            >
              {log.lines.join("\n")}
            </pre>
          )}
        </div>

        <div className="px-6 py-2.5 border-t border-border text-[11px] text-slate-500 flex items-center justify-between">
          <span>Refreshing every {POLL_MS / 1000}s · last {TAIL_LINES} lines</span>
          {log?.mtime && (
            <span>updated {new Date(log.mtime * 1000).toLocaleTimeString()}</span>
          )}
        </div>
      </div>
    </div>
  );
}
