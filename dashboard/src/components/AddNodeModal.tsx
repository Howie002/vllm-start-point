"use client";

import { useState } from "react";

interface Props {
  masterIp: string;
  onClose: () => void;
  onAdded: () => void;
}

export function AddNodeModal({ masterIp, onClose, onAdded }: Props) {
  const [previewPort, setPreviewPort] = useState(5000);
  const [copied, setCopied]           = useState(false);
  const [name, setName]               = useState("");
  const [ip, setIp]                   = useState("");
  const [agentPort, setAgentPort]     = useState(5000);
  const [saving, setSaving]           = useState(false);
  const [testing, setTesting]         = useState(false);
  const [testResult, setTestResult]   = useState<"ok" | "fail" | null>(null);
  const [error, setError]             = useState<string | null>(null);
  const [done, setDone]               = useState(false);

  const master = masterIp || "MASTER_IP";

  const setupCmd =
    `VLLM_NONINTERACTIVE=1 VLLM_ROLE=child ` +
    `VLLM_THIS_IP=<child-ip> ` +
    `VLLM_MASTER_IP=${master} ` +
    `VLLM_AGENT_PORT=${previewPort} ` +
    `bash ./node.sh setup`;

  async function copyCmd() {
    await navigator.clipboard.writeText(setupCmd);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function testConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch(`http://${ip}:${agentPort}/health`, {
        signal: AbortSignal.timeout(4000),
      });
      setTestResult(res.ok ? "ok" : "fail");
    } catch {
      setTestResult("fail");
    } finally {
      setTesting(false);
    }
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !ip.trim()) { setError("Name and IP are required."); return; }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/nodes/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), ip: ip.trim(), agent_port: agentPort }),
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setDone(true);
      onAdded();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-card border border-border rounded-2xl w-full max-w-lg mx-4 shadow-2xl overflow-y-auto max-h-[90vh]">

        {/* Header */}
        <div className="px-6 py-4 border-b border-border flex items-center justify-between">
          <h2 className="text-white font-semibold">Add Child Node</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-white text-lg leading-none">✕</button>
        </div>

        {!done ? (
          <div className="px-6 py-5 space-y-6">

            {/* ── Step 1 ─────────────────────────────────────────── */}
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="w-5 h-5 rounded-full bg-blue-600 text-white text-xs font-bold flex items-center justify-center flex-shrink-0">1</span>
                <p className="text-sm font-semibold text-white">Set up the child machine</p>
              </div>

              <p className="text-xs text-slate-400 leading-relaxed">
                The child machine needs to run <code className="text-cyan-400 font-mono">node.sh setup</code> with
                {" "}<code className="text-cyan-400 font-mono">VLLM_ROLE=child</code> to install vLLM, configure the
                control agent, and start it. Run the command below on that machine.
              </p>

              {/* Agent port preview — affects the command */}
              <div className="flex items-center gap-3">
                <label className="text-xs text-slate-500 whitespace-nowrap">Child agent port</label>
                <input
                  type="number"
                  value={previewPort}
                  onChange={(e) => { setPreviewPort(Number(e.target.value)); setAgentPort(Number(e.target.value)); }}
                  className="w-24 bg-slate-800 border border-border rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500"
                />
                <span className="text-xs text-slate-600">(default 5000 — change if port is taken)</span>
              </div>

              {/* Command block */}
              <div className="bg-slate-900 border border-border rounded-lg p-3 relative">
                <pre className="text-xs font-mono leading-relaxed pr-14 whitespace-pre-wrap break-all">
                  <span className="text-slate-500">git clone &lt;repo-url&gt; &amp;&amp; cd &lt;repo-dir&gt;</span>
                  {"\n"}
                  <span className="text-emerald-300">VLLM_NONINTERACTIVE</span>
                  <span className="text-slate-400">=</span>
                  <span className="text-amber-300">1</span>
                  {"  "}
                  <span className="text-emerald-300">VLLM_ROLE</span>
                  <span className="text-slate-400">=</span>
                  <span className="text-amber-300">child</span>
                  {"\n"}
                  <span className="text-emerald-300">VLLM_THIS_IP</span>
                  <span className="text-slate-400">=</span>
                  <span className="text-red-300">&lt;child-ip&gt;</span>
                  {"  "}
                  <span className="text-emerald-300">VLLM_MASTER_IP</span>
                  <span className="text-slate-400">=</span>
                  <span className="text-amber-300">{master}</span>
                  {"\n"}
                  <span className="text-emerald-300">VLLM_AGENT_PORT</span>
                  <span className="text-slate-400">=</span>
                  <span className="text-amber-300">{previewPort}</span>
                  {"  "}
                  <span className="text-cyan-300">bash ./node.sh setup</span>
                </pre>
                <button
                  onClick={copyCmd}
                  className="absolute top-2 right-2 text-xs px-2 py-1 rounded bg-slate-700 text-slate-300 hover:bg-slate-600 transition-colors"
                >
                  {copied ? "Copied!" : "Copy"}
                </button>
              </div>

              <p className="text-xs text-slate-500">
                Replace <code className="text-red-300 font-mono">&lt;child-ip&gt;</code> with the child machine&apos;s
                actual IP address. If the repo is already cloned on that machine, skip the first line.
                Setup installs dependencies, configures the agent, and starts it automatically — it takes a few minutes.
              </p>
            </div>

            <div className="border-t border-border" />

            {/* ── Step 2 ─────────────────────────────────────────── */}
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="w-5 h-5 rounded-full bg-slate-700 text-slate-300 text-xs font-bold flex items-center justify-center flex-shrink-0">2</span>
                <p className="text-sm font-semibold text-white">Register it here once setup is complete</p>
              </div>

              <p className="text-xs text-slate-400 leading-relaxed">
                Once <code className="text-cyan-400 font-mono">node.sh setup</code> finishes on the child machine and
                the agent is running, come back here and enter the node&apos;s details below to add it to the dashboard.
              </p>

              <form onSubmit={handleAdd} className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div className="col-span-2">
                    <label className="text-xs text-slate-400 font-medium uppercase tracking-wider mb-1 block">Node name</label>
                    <input
                      type="text"
                      value={name}
                      placeholder="e.g. GPU Server 2"
                      onChange={(e) => setName(e.target.value)}
                      className="w-full bg-slate-800 border border-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 placeholder-slate-600"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-slate-400 font-medium uppercase tracking-wider mb-1 block">Child IP address</label>
                    <input
                      type="text"
                      value={ip}
                      placeholder="10.x.x.x"
                      onChange={(e) => { setIp(e.target.value); setTestResult(null); }}
                      className="w-full bg-slate-800 border border-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 placeholder-slate-600"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-slate-400 font-medium uppercase tracking-wider mb-1 block">Agent port</label>
                    <input
                      type="number"
                      value={agentPort}
                      onChange={(e) => setAgentPort(Number(e.target.value))}
                      className="w-full bg-slate-800 border border-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                    />
                  </div>
                </div>

                {/* Test connection */}
                {ip && (
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={testConnection}
                      disabled={testing}
                      className="text-xs px-3 py-1.5 rounded border border-border text-slate-400 hover:text-white hover:border-slate-500 disabled:opacity-50 transition-colors"
                    >
                      {testing ? "Testing…" : "Test connection"}
                    </button>
                    {testResult === "ok"   && <span className="text-xs text-emerald-400">Agent is online and reachable.</span>}
                    {testResult === "fail" && <span className="text-xs text-amber-400">Not reachable — check that setup completed and the agent is running.</span>}
                  </div>
                )}

                {error && (
                  <p className="text-xs text-red-400 bg-red-900/20 border border-red-800 rounded-lg px-3 py-2">{error}</p>
                )}

                <div className="flex gap-3 justify-end pt-1">
                  <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-slate-300 hover:text-white transition-colors">
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={saving}
                    className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50 transition-colors"
                  >
                    {saving ? "Saving…" : "Add Node"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        ) : (
          /* ── Done state ─────────────────────────────────────── */
          <div className="px-6 py-5 space-y-4">
            <div className="flex items-center gap-2 text-emerald-400 text-sm font-medium">
              <span className="w-2 h-2 rounded-full bg-emerald-400" />
              {name} ({ip}:{agentPort}) has been added to the dashboard.
            </div>
            <p className="text-xs text-slate-400">
              The node will appear in the dashboard immediately. If it shows as unreachable, the agent
              may still be starting — it should come online within a minute of setup completing.
            </p>
            <div className="flex justify-end">
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm rounded-lg bg-slate-700 hover:bg-slate-600 text-white transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
