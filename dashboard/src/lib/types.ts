export interface GPUProcess {
  pid: number;
  label: string;
  vram_used_mb: number;
}

export interface GPU {
  index: number;
  name: string;
  vram_used_mb: number;
  vram_free_mb: number;
  vram_total_mb: number;
  unified_memory?: boolean;
  utilization_pct: number;
  temperature_c: number | null;
  fan_speed_pct: number | null;
  clock_mhz: number | null;
  power_draw_w: number | null;
  power_limit_w: number | null;
  processes: GPUProcess[];
}

export interface VLLMInstance {
  port: number;
  model_id: string | null;
  served_name: string | null;
  gpu_index: number | null;
  pid: number;
  status: "healthy" | "loading";
  context_length: number | null;
  gpu_memory_utilization: number | null;
  quantization: string | null;
  tensor_parallel_size: number | null;
  max_num_seqs: number | null;
}

export interface ProxyStatus {
  healthy: boolean;
  models: string[];
  // URL of the cluster LiteLLM proxy the agent is reporting on. Same for every
  // node in the cluster (one proxy per cluster, lives on master/both).
  url?: string;
}

export interface UpdateStatus {
  behind: number;
  ahead: number;
  dirty: boolean;
  local_sha: string | null;
  remote_sha: string | null;
  branch: string;
  repo_url: string;
  last_checked: number | null;
  error: string | null;
  checking: boolean;
}

export interface UpdateConfig {
  repo_url: string;
  branch: string;
  auto_pull_on_start: boolean;
}

export interface FullStatus {
  gpus: GPU[];
  instances: VLLMInstance[];
  proxy: ProxyStatus;
  update?: UpdateStatus;
}

export interface ModelEntry {
  id: string;
  name: string;
  family: string;
  type: "chat" | "reasoning" | "embedding";
  size_b: number;
  vram_gb: number;
  min_gpus: number;
  quantization: string;
  max_context: number;
  description: string;
  flags: Record<string, unknown>;
  cached: boolean;
  enabled: boolean;
}

export interface NodeConfig {
  name: string;
  ip: string;
  agent_port: number;
  setup_cmd?: string;
}

export interface ClusterNodeStatus {
  node: NodeConfig;
  status: FullStatus | null;
  error: string | null;
}

export interface ClusterGPU {
  node: NodeConfig;
  gpu: GPU;
}

// Optimistic record of a model launch the user just kicked off, kept in
// dashboard state until the agent's /status surfaces a matching healthy
// instance (or a hard timeout fires). Bridges the up-to-15s gap between
// Deploy succeeding and the next status poll picking up the new vLLM
// process, so the GPU view can render a "Loading…" banner immediately
// instead of looking idle for that window.
export interface PendingLaunch {
  nodeIp: string;
  nodeAgentPort: number;
  gpuIndices: number[];
  modelId: string;
  modelName: string;
  servedName: string;
  startedAt: number;
}

export interface RepackAssignment {
  served_name: string;
  model_id: string;
  port: number;
  original_gpu: number | null;
  new_gpu: number | null;
  original_utilization: number;
  new_utilization: number;
  vram_required_gb: number | null;
  gpu_total_vram_gb: number | null;
  status: "unchanged" | "reassigned" | "adjusted" | "reassigned+adjusted" | "already_running";
}

export interface RepackResult {
  assignments: RepackAssignment[];
  solvable: boolean;
  unsolvable: Array<{ served_name: string; port: number; required_gb: number }>;
}

export interface PreflightCheck {
  served_name: string;
  model_id: string;
  port: number;
  gpu_indices: number[];
  gpu_memory_utilization: number;
  required_vram_gb: number;
  available_vram_gb: number;
  total_vram_gb: number;
  fits: boolean;
  already_running: boolean;
  alternative_gpus: number[];
  suggested_utilization: number | null;
}

export interface PreflightResult {
  checks: PreflightCheck[];
  all_fit: boolean;
  warnings: string[];
}

export interface StackModelConfig {
  model_id: string;
  served_name: string;
  gpu_indices: number[];
  port: number;
  gpu_memory_utilization: number;
  extra_flags: Record<string, unknown>;
}

export interface StackConfig {
  name: string;
  description: string;
  models: StackModelConfig[];
  running_count?: number;
  total_count?: number;
}

export interface LaunchRequest {
  model_id: string;
  gpu_indices: number[];
  port: number;
  served_name: string;
  register_with_proxy: boolean;
  extra_flags: Record<string, unknown>;
}

// ── Analytics ───────────────────────────────────────────────────────────────
// One row per (time bucket × GPU) from a single node's history.
export interface MetricsGpuBucket {
  bucket_ts: number;
  gpu_idx: number;
  util_pct_avg: number | null;
  util_pct_p95: number | null;
  vram_used_mb_avg: number | null;
  vram_used_mb_max: number | null;
  coresident_pct: number | null;
  power_w_avg: number | null;
  temp_c_avg: number | null;
}

// One row per (time bucket × served_name × gpu) from a single node's history.
// Token counts and request counts are deltas within the bucket, not cumulative.
export interface MetricsModelBucket {
  bucket_ts: number;
  served_name: string;
  gpu_idx: number | null;
  prompt_tokens: number;
  generation_tokens: number;
  requests: number;
  running_avg: number | null;
  running_max: number | null;
  waiting_avg: number | null;
  waiting_max: number | null;
  ttft_p50_ms_avg: number | null;
  ttft_p95_ms_avg: number | null;
}

export interface MetricsQueryResult {
  range: string;
  resolution: string;
  since_ts: number;
  gpus: MetricsGpuBucket[];
  models: MetricsModelBucket[];
}

// ── HF integration ──────────────────────────────────────────────────────────
export interface HFTokenStatus {
  set: boolean;
  preview?: string;
}

export interface HFLookup {
  status: "ok" | "gated_unauthorized" | "not_found" | "network_error";
  model_id: string;
  message?: string;
  gated?: boolean;
  pipeline_tag?: string;
  type?: "chat" | "reasoning" | "embedding";
  params_b?: number | null;
  total_bytes?: number;
  vram_gb_estimate?: number | null;
  quant_guess?: string;
  context_length?: number | null;
  tags?: string[];
  license?: string | null;
}

export interface CachedModel {
  model_id: string;
  size_bytes: number;
  path: string;
}

export interface CacheStats {
  cache_used_bytes: number;
  disk_total_bytes: number;
  disk_used_bytes: number;
  disk_free_bytes: number;
  cache_path: string;
}

export interface DynamicLog {
  port: number;
  exists: boolean;
  size_bytes: number;
  mtime: number | null;
  lines: string[];
  truncated: boolean;
  path: string;
}

export interface DownloadState {
  model_id: string;
  state: "pending" | "downloading" | "complete" | "error" | "canceled";
  bytes_done: number;
  bytes_total: number;
  started_at: number;
  finished_at?: number | null;
  error?: string | null;
}
