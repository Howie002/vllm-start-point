"use client";

import type { ClusterNodeStatus, NodeConfig, VLLMInstance } from "@/lib/types";

interface Props {
  nodeStatuses: ClusterNodeStatus[];
}

const LITELLM_PORT = 4000;

interface InstanceWithNode {
  node: NodeConfig;
  inst: VLLMInstance;
}

// ── Endpoint catalogs ────────────────────────────────────────────────────────
// Each row shows what an endpoint does so the user doesn't have to cross-reference
// OpenAI / vLLM / LiteLLM docs to know which URL to hit for what.

interface EndpointDef {
  label:   string;
  path:    string;
  desc:    string;
  accent?: boolean;  // highlight as the "primary" path
}

const PROXY_ENDPOINTS: EndpointDef[] = [
  { label: "Chat completions",   path: "/v1/chat/completions", desc: "Primary endpoint for chat models. OpenAI-compatible — works with the openai SDK by pointing base_url here.", accent: true },
  { label: "Completions",        path: "/v1/completions",      desc: "Legacy non-chat text completion. Some older models expect this format; most new models want /chat/completions." },
  { label: "Embeddings",         path: "/v1/embeddings",       desc: "Convert text to vectors. Only works if an embedding model (e.g. GTE-Qwen2) is registered on the proxy." },
  { label: "List models",        path: "/v1/models",           desc: "Returns the set of model names the proxy currently routes to. Useful for clients that discover models dynamically." },
  { label: "Health",             path: "/health",              desc: "200 when the proxy is up. Used by monitoring and the dashboard's status dot." },
  { label: "Metrics (Prometheus)", path: "/metrics",           desc: "LiteLLM's metrics — request counts, 4xx/5xx per model, latency. Scraped by the Analytics tab." },
];

const VLLM_ENDPOINTS: EndpointDef[] = [
  { label: "Chat completions",     path: "/v1/chat/completions", desc: "Primary endpoint. Same OpenAI schema as the proxy — bypasses load balancing and targets this one instance.", accent: true },
  { label: "Completions",          path: "/v1/completions",      desc: "Legacy text completion (non-chat). Available on all chat models but most should use /chat/completions." },
  { label: "Embeddings",           path: "/v1/embeddings",       desc: "Only responds if this instance is running an embedding model (e.g. GTE-Qwen2). Chat models return an error." },
  { label: "List models",          path: "/v1/models",           desc: "Returns the single served_name this instance exposes. The proxy queries this when auto-discovering backends." },
  { label: "Health",               path: "/health",              desc: "200 when the model is loaded and ready. Returns non-200 while weights are still loading on first deploy." },
  { label: "Metrics (Prometheus)", path: "/metrics",             desc: "Per-model metrics: token counters, TTFT histogram, queue depth. Sampled by the agent's analytics sampler every 60s." },
  { label: "Tokenize",             path: "/tokenize",            desc: "POST text → get back the model's tokens. Useful for counting tokens before sending a prompt." },
  { label: "Detokenize",           path: "/detokenize",          desc: "POST tokens → get back text. Inverse of /tokenize." },
];

function EndpointList({ base, endpoints }: { base: string; endpoints: EndpointDef[] }) {
  return (
    <div className="space-y-2">
      {endpoints.map(e => (
        <div key={e.path} className="grid grid-cols-1 sm:grid-cols-[140px_1fr] gap-x-4 gap-y-0.5 text-[11px]">
          <div className="text-slate-400 uppercase tracking-wider pt-0.5">{e.label}</div>
          <div className="min-w-0">
            <span className={`font-mono break-all ${e.accent ? "text-cyan-300" : "text-slate-300"}`}>
              {base}{e.path}
            </span>
            <p className="text-slate-500 mt-0.5 leading-relaxed normal-case">{e.desc}</p>
          </div>
        </div>
      ))}
    </div>
  );
}


export function PortTreeView({ nodeStatuses }: Props) {
  const allInstances: InstanceWithNode[] = nodeStatuses.flatMap(ns =>
    (ns.status?.instances ?? []).map(inst => ({ node: ns.node, inst }))
  );

  // All nodes report the same cluster proxy URL — dedupe so we show it once.
  const proxyMap = new Map<string, { url: string; models: string[] }>();
  for (const ns of nodeStatuses) {
    const p = ns.status?.proxy;
    if (!p?.healthy || !p.url) continue;
    if (!proxyMap.has(p.url)) proxyMap.set(p.url, { url: p.url, models: p.models });
  }
  const proxies = Array.from(proxyMap.values());

  function resolveBackend(servedName: string): InstanceWithNode[] {
    return allInstances.filter(x => x.inst.served_name === servedName);
  }

  return (
    <div className="space-y-4">

      {/* ── Entry points via LiteLLM proxy ─────────────────────────────── */}
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold text-white">LiteLLM Entry Points</h2>
          <p className="text-xs text-slate-500 mt-1 leading-relaxed">
            Preferred target for inference clients. The proxy knows about every vLLM backend in the cluster and load-balances across them by model name. One URL, every model. All endpoints below are OpenAI-compatible unless noted.
          </p>
        </div>

        {proxies.length === 0 ? (
          <p className="px-4 py-6 text-sm text-slate-500 text-center">
            No LiteLLM proxy is currently healthy. Point inference clients at a direct vLLM endpoint below.
          </p>
        ) : (
          <div className="divide-y divide-border">
            {proxies.map(({ url, models }) => {
              const base = url;
              const proxyHost = url.replace(/^https?:\/\//, "").split(":")[0];
              const hostNode = nodeStatuses.find(ns => ns.node.ip === proxyHost)?.node;
              return (
                <div key={url} className="px-4 py-4 space-y-4">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-emerald-400" />
                    <span className="text-xs px-2 py-0.5 rounded bg-slate-800 text-slate-300">
                      {hostNode?.name ?? proxyHost}
                    </span>
                    <span className="text-sm text-slate-200 font-medium">LiteLLM cluster proxy</span>
                    <span className="ml-auto text-xs font-mono text-cyan-400">{url}</span>
                  </div>

                  {/* Client quickstart */}
                  <div className="ml-4 grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1 text-xs">
                    <div>
                      <span className="text-slate-500 uppercase tracking-wider">Base URL</span>
                      <p className="font-mono text-cyan-300 break-all mt-0.5">{base}/v1</p>
                    </div>
                    <div>
                      <span className="text-slate-500 uppercase tracking-wider">Auth header</span>
                      <p className="font-mono text-slate-300 break-all mt-0.5">Authorization: Bearer none</p>
                    </div>
                  </div>

                  {/* Endpoint reference */}
                  <div className="ml-4">
                    <p className="text-xs text-slate-500 uppercase tracking-wider mb-2">Available endpoints</p>
                    <EndpointList base={base} endpoints={PROXY_ENDPOINTS} />
                  </div>

                  {/* Model → backend mapping */}
                  <div className="ml-4 border-t border-border pt-3">
                    <p className="text-xs text-slate-500 uppercase tracking-wider mb-1.5">
                      Model routing ({models.length} registered)
                    </p>
                    <p className="text-[11px] text-slate-500 mb-2 leading-relaxed">
                      When a client sends <span className="font-mono">&quot;model&quot;: &quot;X&quot;</span> to the proxy, requests go to the backend(s) below. Multiple backends per model = load balanced (least-busy routing).
                    </p>
                    {models.length === 0 ? (
                      <p className="text-xs text-slate-500 italic">No models registered yet. Deploy a model to auto-register it with the proxy.</p>
                    ) : (
                      <div className="space-y-1.5">
                        {models.map(modelName => {
                          const backends = resolveBackend(modelName);
                          return (
                            <div key={modelName} className="text-xs font-mono flex flex-col sm:flex-row sm:items-start gap-1 sm:gap-2">
                              <span className="text-emerald-300 min-w-[200px]">{modelName}</span>
                              <span className="text-slate-600">→</span>
                              {backends.length === 0 ? (
                                <span className="text-amber-400">no backend found (registered but no matching vLLM instance — likely the instance was stopped)</span>
                              ) : (
                                <div className="flex flex-col gap-0.5">
                                  {backends.map(b => (
                                    <span key={`${b.node.ip}:${b.inst.port}`} className="text-slate-400">
                                      http://{b.node.ip}:{b.inst.port}/v1
                                      <span className="text-slate-600 ml-2">({b.node.name}, GPU {b.inst.gpu_index ?? "?"}, {b.inst.status})</span>
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Per-node port tree ─────────────────────────────────────────── */}
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold text-white">Direct vLLM Endpoints</h2>
          <p className="text-xs text-slate-500 mt-1 leading-relaxed">
            Per-node port tree. Hit these directly to bypass the proxy — useful for debugging, health probes, or pinning a client to a specific instance. No load balancing; you&apos;re talking to one specific vLLM process.
          </p>
        </div>

        <div className="divide-y divide-border">
          {nodeStatuses.map(ns => {
            const { node, status } = ns;
            const instances = status?.instances ?? [];
            const proxyUrl = status?.proxy.url;
            const proxyHost = proxyUrl?.replace(/^https?:\/\//, "").split(":")[0];
            const hostsProxy = !!proxyUrl && proxyHost === node.ip && (status?.proxy.healthy ?? false);
            return (
              <div key={`${node.ip}:${node.agent_port}`} className="px-4 py-4">
                <div className="flex items-center gap-2 mb-2">
                  <span className={`w-2 h-2 rounded-full ${status ? "bg-emerald-400" : "bg-red-500"}`} />
                  <span className="text-sm font-medium text-white">{node.name}</span>
                  <span className="text-xs font-mono text-slate-500">{node.ip}</span>
                </div>

                {/* Node-level services */}
                <div className="ml-4 space-y-1 text-xs font-mono mb-3">
                  <div className="flex items-start gap-2">
                    <span className="text-slate-500 min-w-[110px]">agent :{node.agent_port}</span>
                    <div className="min-w-0">
                      <span className="text-slate-400">http://{node.ip}:{node.agent_port}</span>
                      <p className="text-slate-500 text-[10px] mt-0.5 normal-case">Control agent — GPU stats, instance mgmt, HF downloads, metrics. Dashboard talks to this.</p>
                    </div>
                  </div>

                  {hostsProxy && (
                    <div className="flex items-start gap-2">
                      <span className="text-slate-500 min-w-[110px]">litellm :{LITELLM_PORT}</span>
                      <div className="min-w-0">
                        <span className="text-cyan-400">{proxyUrl}/v1</span>
                        <p className="text-slate-500 text-[10px] mt-0.5 normal-case">Cluster proxy — this node hosts it. All inference traffic ideally goes through here.</p>
                      </div>
                    </div>
                  )}
                </div>

                {/* vLLM instances */}
                {instances.length === 0 ? (
                  <div className="ml-4 text-xs text-slate-600 italic">No vLLM instances on this node. Deploy a model to start serving.</div>
                ) : (
                  <div className="ml-4 space-y-3">
                    {instances.map(inst => {
                      const instBase = `http://${node.ip}:${inst.port}`;
                      return (
                        <div key={inst.port} className="border-l-2 border-slate-700 pl-3 py-1 space-y-2">
                          <div className="flex items-center gap-2 flex-wrap text-xs">
                            <span className="text-slate-500 min-w-[90px] font-mono">vllm :{inst.port}</span>
                            <span className="text-emerald-300 font-mono">{inst.served_name ?? "—"}</span>
                            <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full ${
                              inst.status === "healthy"
                                ? "bg-emerald-900/40 text-emerald-300"
                                : "bg-amber-900/40 text-amber-300"
                            }`}>
                              {inst.status}
                            </span>
                            <span className="text-slate-600">·</span>
                            <span className="text-slate-500">GPU {inst.gpu_index ?? "?"}</span>
                            <span className="text-slate-600">·</span>
                            <span className="text-slate-500 font-mono truncate max-w-[240px]">{inst.model_id ?? "—"}</span>
                          </div>

                          <div className="ml-[98px]">
                            <EndpointList base={instBase} endpoints={VLLM_ENDPOINTS} />
                          </div>
                        </div>
                      );
                    })}
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
