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
}

export interface FullStatus {
  gpus: GPU[];
  instances: VLLMInstance[];
  proxy: ProxyStatus;
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
