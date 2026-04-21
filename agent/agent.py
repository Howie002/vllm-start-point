"""
vLLM Stack Control Agent
Runs on the GPU machine. Exposes a REST API for the dashboard (VM or local).
Port: 5000
"""

import json
import os
import signal
import subprocess
import sys
import threading
import time
import urllib.request
import urllib.error
from pathlib import Path
from typing import Optional

import psutil
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from metrics import MetricsSampler, query_metrics
import models_hf

# ── Config ────────────────────────────────────────────────────────────────────

VLLM_BIN       = os.path.expanduser("~/.vllm-venv/bin/vllm")
LITELLM_KEY    = "none"
SCAN_PORT_MIN  = 8000
# Must cover the range DeployModal.tsx allocates from (currently 8020–8099).
# Previously capped at 8020, which missed every instance beyond the first.
SCAN_PORT_MAX  = 8099
LIBRARY_PATH        = Path(__file__).parent / "model_library.json"
STACK_CONFIGS_PATH  = Path(__file__).parent.parent / "stack_configs.json"
NODE_CONFIG_PATH    = Path(__file__).parent.parent / "node_config.json"
PROXY_CONFIG_PATH   = Path(__file__).parent.parent / "litellm" / "cluster_config.yaml"
PROXY_PID_FILE      = Path(__file__).parent.parent / "litellm" / ".proxy_pid"
PROXY_START_SH      = Path(__file__).parent.parent / "litellm" / "start_proxy.sh"
HF_CACHE            = Path.home() / ".cache" / "huggingface" / "hub"

_PROXY_LOCK = threading.Lock()
CUDA_ENV = {
    **os.environ,
    "PATH": f"{Path.home()}/.vllm-venv/bin:/usr/local/cuda-12.8/bin:/usr/local/cuda/bin:{os.environ.get('PATH', '')}",
}


# ── Node config (read once at import; cheap to re-read if needed) ─────────────
# `this_ip` is the externally-reachable IP the agent reports + uses when
# registering model backends with the cluster proxy. `cluster_proxy` is where
# model registrations are POSTed — on a master/both node it points at this
# node's own :4000; on a child node it points at the master's :4000.

def _load_node_config() -> dict:
    try:
        with open(NODE_CONFIG_PATH) as f:
            return json.load(f)
    except Exception:
        return {}

_NODE_CFG = _load_node_config()

THIS_IP = _NODE_CFG.get("this_ip") or "localhost"

def _cluster_proxy_url() -> str:
    cp = _NODE_CFG.get("cluster_proxy") or {}
    ip = cp.get("ip")
    port = cp.get("port", 4000)
    if not ip:
        # Legacy configs without cluster_proxy: assume master runs the proxy.
        ip = (_NODE_CFG.get("master") or {}).get("ip") or "localhost"
    return f"http://{ip}:{port}"

CLUSTER_PROXY_URL = _cluster_proxy_url()

# ── App ───────────────────────────────────────────────────────────────────────

app = FastAPI(title="vLLM Stack Control Agent", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Pydantic models ───────────────────────────────────────────────────────────

class LaunchRequest(BaseModel):
    model_id: str
    gpu_indices: list[int]
    port: int
    served_name: str
    register_with_proxy: bool = True
    extra_flags: dict = {}

class ProxyRegisterRequest(BaseModel):
    model_name: str
    api_base: str
    served_name: str

class StackModelEntry(BaseModel):
    model_id: str
    served_name: str
    gpu_indices: list[int]
    port: int
    gpu_memory_utilization: float = 0.85
    extra_flags: dict = {}

class StackConfig(BaseModel):
    name: str
    description: str = ""
    models: list[StackModelEntry]

# ── Helpers ───────────────────────────────────────────────────────────────────

def _nvidia_smi_query(fields: str) -> list[dict]:
    result = subprocess.run(
        ["nvidia-smi", f"--query-gpu={fields}", "--format=csv,noheader,nounits"],
        capture_output=True, text=True, timeout=5
    )
    rows = []
    for line in result.stdout.strip().splitlines():
        values = [v.strip() for v in line.split(",")]
        rows.append(values)
    return rows


def _http_get(url: str, headers: dict = {}) -> Optional[dict]:
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=3) as r:
            return json.loads(r.read())
    except Exception:
        return None


def _http_post(url: str, data: dict, headers: dict = {}) -> Optional[dict]:
    try:
        body = json.dumps(data).encode()
        req = urllib.request.Request(url, data=body, headers={
            "Content-Type": "application/json",
            **headers
        }, method="POST")
        with urllib.request.urlopen(req, timeout=5) as r:
            return json.loads(r.read())
    except Exception:
        return None


def _http_delete(url: str, headers: dict = {}) -> bool:
    try:
        req = urllib.request.Request(url, headers=headers, method="DELETE")
        with urllib.request.urlopen(req, timeout=5):
            return True
    except Exception:
        return False


def _proxy_write_and_restart(
    extra_add: Optional[dict] = None,
    remove_served: Optional[str] = None,
) -> None:
    """Rewrite cluster_config.yaml from running instances, then restart the proxy.

    extra_add: {"served_name": ..., "port": ...} for an instance just spawned
               (not yet visible to _scan_vllm_instances).
    remove_served: served_name to exclude (instance being stopped right now).

    Only takes effect when this node hosts the proxy (role master or both).
    Runs under _PROXY_LOCK to serialise concurrent launch/stop calls.
    """
    role = _NODE_CFG.get("role", "")
    if role not in ("master", "both"):
        # Child nodes tell the master to sync instead.
        master_ip   = (_NODE_CFG.get("master") or {}).get("ip")
        master_port = (_NODE_CFG.get("master") or {}).get("agent_port", 5000)
        if master_ip:
            _http_post(f"http://{master_ip}:{master_port}/proxy/sync", {})
        return

    with _PROXY_LOCK:
        instances = _scan_vllm_instances()

        # Build deduplicated (served_name, ip, port) set
        seen: set[tuple] = set()
        for inst in instances:
            s, p = inst.get("served_name"), inst.get("port")
            if s and p and s != remove_served:
                seen.add((s, THIS_IP, p))

        if extra_add:
            s = extra_add.get("served_name")
            p = extra_add.get("port")
            if s and p:
                seen.add((s, THIS_IP, p))

        entries = []
        for served_name, host_ip, port in sorted(seen):
            entries.append(
                f"  - model_name: {served_name}\n"
                f"    litellm_params:\n"
                f"      model: openai/{served_name}\n"
                f"      api_base: http://{host_ip}:{port}/v1\n"
                f"      api_key: none"
            )

        model_list = ("\n".join(entries)) if entries else "  []"
        # Only write a list block when there are entries
        if entries:
            model_block = f"model_list:\n{model_list}"
        else:
            model_block = "model_list: []"

        config_text = (
            "# Cluster LiteLLM proxy config.\n"
            "# Generated by the control agent — do not edit by hand.\n\n"
            f"{model_block}\n\n"
            "router_settings:\n"
            "  routing_strategy: least-busy\n"
            "  num_retries: 3\n"
            "  timeout: 30\n"
            "  retry_after: 5\n\n"
            "litellm_settings:\n"
            "  drop_params: true\n"
            "  request_timeout: 600\n\n"
            "general_settings:\n"
            '  master_key: "none"\n'
        )

        PROXY_CONFIG_PATH.write_text(config_text)

        # Stop existing proxy
        if PROXY_PID_FILE.exists():
            try:
                pid = int(PROXY_PID_FILE.read_text().strip())
                os.kill(pid, signal.SIGTERM)
                time.sleep(1)
            except Exception:
                pass

        # Restart proxy in the background so this request can return promptly
        proxy_port = (_NODE_CFG.get("cluster_proxy") or {}).get("port", 4000)
        subprocess.Popen(
            ["bash", str(PROXY_START_SH)],
            env={**os.environ, "LITELLM_PORT": str(proxy_port), "PROXY_BIND_IP": THIS_IP},
            start_new_session=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )


def _get_pid_on_port(port: int) -> Optional[int]:
    for conn in psutil.net_connections(kind="inet"):
        if conn.laddr.port == port and conn.status == "LISTEN":
            return conn.pid
    return None


def _listening_port_map() -> dict[int, int]:
    """Return {port: pid} for all LISTEN sockets. Single net_connections() call."""
    result = {}
    try:
        for conn in psutil.net_connections(kind="inet"):
            if conn.status == "LISTEN" and conn.pid:
                result[conn.laddr.port] = conn.pid
    except Exception:
        pass
    return result


def _get_gpu_for_pid(pid: int, gpu_pids: dict[int, list[int]]) -> Optional[int]:
    """gpu_pids maps gpu_index -> [pids using it]"""
    # Check direct PID and all children
    try:
        proc = psutil.Process(pid)
        all_pids = {pid} | {c.pid for c in proc.children(recursive=True)}
    except Exception:
        all_pids = {pid}

    for gpu_idx, pids in gpu_pids.items():
        if all_pids & set(pids):
            return gpu_idx
    return None


def _scan_vllm_instances() -> list[dict]:
    # Map GPU index -> list of compute PIDs
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-compute-apps=pid,gpu_uuid", "--format=csv,noheader"],
            capture_output=True, text=True, timeout=5
        )
        # Get GPU uuid -> index mapping
        uuid_result = subprocess.run(
            ["nvidia-smi", "--query-gpu=index,uuid", "--format=csv,noheader"],
            capture_output=True, text=True, timeout=5
        )
        uuid_to_idx = {}
        for line in uuid_result.stdout.strip().splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) == 2:
                uuid_to_idx[parts[1]] = int(parts[0])

        gpu_pids: dict[int, list[int]] = {}
        for line in result.stdout.strip().splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) >= 2:
                try:
                    pid = int(parts[0])
                    gpu_idx = uuid_to_idx.get(parts[1])
                    if gpu_idx is not None:
                        gpu_pids.setdefault(gpu_idx, []).append(pid)
                except ValueError:
                    pass
    except Exception:
        gpu_pids = {}

    port_map = _listening_port_map()
    instances = []
    for port in range(SCAN_PORT_MIN, SCAN_PORT_MAX + 1):
        pid = port_map.get(port)
        if pid is None:
            continue

        # Check it's actually a vLLM process
        try:
            proc = psutil.Process(pid)
            cmd = " ".join(proc.cmdline())
            if "vllm" not in cmd.lower():
                continue
        except Exception:
            continue

        # Get health + model info from vLLM
        health_ok = False
        try:
            urllib.request.urlopen(f"http://localhost:{port}/health", timeout=3)
            health_ok = True
        except Exception:
            pass

        model_id = None
        served_name = None
        models_data = _http_get(f"http://localhost:{port}/v1/models")
        if models_data and "data" in models_data:
            entries = models_data["data"]
            if entries:
                model_id = entries[0].get("id")
                served_name = model_id

        # Parse model id, served name, and launch flags from cmdline
        gpu_memory_util   = None
        max_model_len     = None
        quantization      = None
        tensor_parallel   = None
        max_num_seqs      = None
        try:
            cmdline = psutil.Process(pid).cmdline()
            for i, arg in enumerate(cmdline):
                if arg == "serve" and i + 1 < len(cmdline):
                    model_id = cmdline[i + 1]
                if arg == "--served-model-name" and i + 1 < len(cmdline):
                    served_name = cmdline[i + 1]
                if arg == "--gpu-memory-utilization" and i + 1 < len(cmdline):
                    try: gpu_memory_util = float(cmdline[i + 1])
                    except ValueError: pass
                if arg == "--max-model-len" and i + 1 < len(cmdline):
                    try: max_model_len = int(cmdline[i + 1])
                    except ValueError: pass
                if arg == "--quantization" and i + 1 < len(cmdline):
                    quantization = cmdline[i + 1]
                if arg == "--tensor-parallel-size" and i + 1 < len(cmdline):
                    try: tensor_parallel = int(cmdline[i + 1])
                    except ValueError: pass
                if arg == "--max-num-seqs" and i + 1 < len(cmdline):
                    try: max_num_seqs = int(cmdline[i + 1])
                    except ValueError: pass
        except Exception:
            pass

        # Supplement max_model_len from the models API if not in cmdline
        if max_model_len is None and models_data and "data" in models_data:
            entries = models_data["data"]
            if entries:
                max_model_len = entries[0].get("max_model_len")

        gpu_index = _get_gpu_for_pid(pid, gpu_pids)

        instances.append({
            "port":                  port,
            "model_id":              model_id,
            "served_name":           served_name,
            "gpu_index":             gpu_index,
            "pid":                   pid,
            "status":                "healthy" if health_ok else "loading",
            "context_length":        max_model_len,
            "gpu_memory_utilization":gpu_memory_util,
            "quantization":          quantization,
            "tensor_parallel_size":  tensor_parallel,
            "max_num_seqs":          max_num_seqs,
        })

    return instances


def _get_gpu_processes() -> dict[int, list[dict]]:
    """Returns {gpu_index: [process_info, ...]} for every process using GPU VRAM."""
    try:
        # UUID → index map
        uuid_result = subprocess.run(
            ["nvidia-smi", "--query-gpu=index,uuid", "--format=csv,noheader"],
            capture_output=True, text=True, timeout=5
        )
        uuid_to_idx: dict[str, int] = {}
        for line in uuid_result.stdout.strip().splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) == 2:
                try:
                    uuid_to_idx[parts[1]] = int(parts[0])
                except ValueError:
                    pass

        # All compute processes
        apps_result = subprocess.run(
            ["nvidia-smi",
             "--query-compute-apps=pid,gpu_uuid,used_memory",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5
        )

        by_gpu: dict[int, list[dict]] = {}
        for line in apps_result.stdout.strip().splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) < 3:
                continue
            try:
                pid      = int(parts[0])
                gpu_idx  = uuid_to_idx.get(parts[1])
                vram_mb  = int(parts[2]) if parts[2].isdigit() else 0
            except ValueError:
                continue
            if gpu_idx is None:
                continue

            label = _process_label(pid)
            by_gpu.setdefault(gpu_idx, []).append({
                "pid":          pid,
                "label":        label,
                "vram_used_mb": vram_mb,
            })

        return by_gpu
    except Exception:
        return {}


def _process_label(pid: int) -> str:
    """Return a human-readable one-line description of a process."""
    try:
        proc    = psutil.Process(pid)
        cmdline = proc.cmdline()
        name    = proc.name()

        if not cmdline:
            return name

        cmd = " ".join(cmdline)

        # vLLM
        for i, arg in enumerate(cmdline):
            if arg == "serve" and i + 1 < len(cmdline):
                return f"vllm · {cmdline[i + 1]}"

        # Python scripts — show script filename + first meaningful arg
        if name in ("python", "python3", "python3.12") and len(cmdline) > 1:
            script = cmdline[1]
            # Strip path, keep filename
            script_name = script.rsplit("/", 1)[-1]
            # Try to find a meaningful second arg (config, model path, etc.)
            extra = ""
            for arg in cmdline[2:]:
                if not arg.startswith("-") and len(arg) < 60:
                    extra = f" · {arg.rsplit('/', 1)[-1]}"
                    break
            return f"{script_name}{extra}"

        # Anything else — exe name + up to 40 chars of args
        args_str = " ".join(cmdline[1:])[:40]
        return f"{name}  {args_str}".strip()

    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return f"pid {pid}"


def _cached_model_ids() -> set[str]:
    cached = set()
    if not HF_CACHE.exists():
        return cached
    for d in HF_CACHE.iterdir():
        if d.is_dir() and d.name.startswith("models--"):
            # models--org--name -> org/name
            parts = d.name[len("models--"):].split("--", 1)
            if len(parts) == 2:
                cached.add(f"{parts[0]}/{parts[1]}")
    return cached


def _next_free_port(used_ports: set[int]) -> int:
    listening = _listening_port_map()
    for port in range(8020, 8100):
        if port not in used_ports and port not in listening:
            return port
    raise RuntimeError("No free ports found in range 8020-8100")

# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok"}


def _parse_num(s: str) -> Optional[float]:
    s = s.strip().replace("[N/A]", "").replace("N/A", "").replace("Not Supported", "").strip()
    try:
        return float(s)
    except ValueError:
        return None


def _unified_mem_mb(gpu_index: int) -> tuple[int, int]:
    """Return (total_mb, free_mb) for unified-memory GPUs (e.g. DGX Spark GB10).
    Falls back to system RAM when torch is unavailable."""
    try:
        import torch
        if torch.cuda.is_available():
            free_b, total_b = torch.cuda.mem_get_info(gpu_index)
            if total_b > 0:
                return int(total_b // (1024 * 1024)), int(free_b // (1024 * 1024))
    except Exception:
        pass
    try:
        mem = psutil.virtual_memory()
        total_mb = int(mem.total // (1024 * 1024))
        avail_mb = int(mem.available // (1024 * 1024))
        return total_mb, avail_mb
    except Exception:
        pass
    return 0, 0


def _is_not_supported(s: str) -> bool:
    return s.strip().lower() in ("not supported", "[not supported]", "n/a", "[n/a]", "")


@app.get("/gpus")
def get_gpus():
    try:
        rows = _nvidia_smi_query(
            "index,name,memory.used,memory.free,memory.total,"
            "utilization.gpu,temperature.gpu,fan.speed,"
            "clocks.current.graphics,power.draw,power.limit"
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    gpu_procs = _get_gpu_processes()

    gpus = []
    for row in rows:
        if len(row) < 6:
            continue
        try:
            idx = int(row[0])

            # Handle unified memory GPUs (e.g. DGX Spark GB10) where nvidia-smi
            # returns "Not Supported" for memory fields
            mem_used_s  = row[2].strip()
            mem_free_s  = row[3].strip()
            mem_total_s = row[4].strip()

            if _is_not_supported(mem_total_s):
                total_mb, free_mb = _unified_mem_mb(idx)
                used_mb = total_mb - free_mb
                unified = True
            else:
                total_mb = int(mem_total_s)
                used_mb  = int(mem_used_s)  if not _is_not_supported(mem_used_s)  else 0
                free_mb  = int(mem_free_s)  if not _is_not_supported(mem_free_s)  else total_mb
                unified = False

            gpus.append({
                "index":             idx,
                "name":              row[1].strip(),
                "vram_used_mb":      used_mb,
                "vram_free_mb":      free_mb,
                "vram_total_mb":     total_mb,
                "unified_memory":    unified,
                "utilization_pct":   int(row[5]) if row[5].strip().lstrip("-").isdigit() else 0,
                "temperature_c":     _parse_num(row[6])  if len(row) > 6  else None,
                "fan_speed_pct":     _parse_num(row[7])  if len(row) > 7  else None,
                "clock_mhz":         _parse_num(row[8])  if len(row) > 8  else None,
                "power_draw_w":      _parse_num(row[9])  if len(row) > 9  else None,
                "power_limit_w":     _parse_num(row[10]) if len(row) > 10 else None,
                "processes":         gpu_procs.get(idx, []),
            })
        except (ValueError, IndexError):
            pass

    return gpus


@app.get("/instances")
def get_instances():
    return _scan_vllm_instances()


@app.post("/instances/launch")
def launch_instance(req: LaunchRequest):
    if not Path(VLLM_BIN).exists():
        raise HTTPException(status_code=500, detail=f"vLLM binary not found at {VLLM_BIN}")

    # Check port is free
    if _get_pid_on_port(req.port):
        raise HTTPException(status_code=409, detail=f"Port {req.port} is already in use")

    # Preflight the HF repo — kills the silent gating problem. If the model isn't
    # already cached on this node, we need to be able to pull it. If it IS cached
    # locally, we skip the check — lookup_model requires network, and offline
    # operation on a cached model is legitimate.
    if req.model_id not in _cached_model_ids():
        pf = models_hf.preflight(req.model_id)
        if pf["status"] == "gated_unauthorized":
            raise HTTPException(
                status_code=403,
                detail=f"HF access denied for '{req.model_id}'. Set an HF_TOKEN on this node with access to the repo, then retry."
            )
        if pf["status"] == "not_found":
            raise HTTPException(status_code=404, detail=pf.get("message", f"Repo '{req.model_id}' not found on HuggingFace"))
        # network_error is a soft warning — we let launch proceed; vLLM will
        # surface the real error in its own log. `ok` means we're good.

    gpu_str = ",".join(str(g) for g in req.gpu_indices)

    flags = req.extra_flags

    # gpu_memory_utilization: flag overrides default of 0.85
    gpu_mem_util = str(flags.get("gpu_memory_utilization", "0.85"))

    cmd = [
        VLLM_BIN, "serve", req.model_id,
        "--port", str(req.port),
        "--served-model-name", req.served_name,
        "--gpu-memory-utilization", gpu_mem_util,
        "--disable-uvicorn-access-log",
    ]

    if flags.get("quantization"):
        cmd += ["--quantization", flags["quantization"]]
    if flags.get("trust_remote_code"):
        cmd += ["--trust-remote-code"]
    if flags.get("runner"):
        cmd += ["--runner", flags["runner"]]
    if flags.get("hf_overrides"):
        cmd += ["--hf-overrides", json.dumps(flags["hf_overrides"])]
    if flags.get("tensor_parallel_size") and int(flags["tensor_parallel_size"]) > 1:
        cmd += ["--tensor-parallel-size", str(flags["tensor_parallel_size"])]
    if flags.get("max_model_len"):
        cmd += ["--max-model-len", str(flags["max_model_len"])]
    if flags.get("max_num_seqs"):
        cmd += ["--max-num-seqs", str(flags["max_num_seqs"])]

    log_path = Path(__file__).parent.parent / "logs" / f"dynamic_{req.port}.log"
    log_path.parent.mkdir(exist_ok=True)

    env = {**CUDA_ENV, "CUDA_VISIBLE_DEVICES": gpu_str}

    with open(log_path, "w") as log_f:
        proc = subprocess.Popen(
            cmd,
            env=env,
            stdout=log_f,
            stderr=log_f,
            start_new_session=True,
        )

    # Update the proxy config (write YAML + restart proxy). Runs in background
    # so the launch response returns immediately while the proxy restarts.
    if req.register_with_proxy:
        threading.Thread(
            target=_proxy_write_and_restart,
            kwargs={"extra_add": {"served_name": req.served_name, "port": req.port}},
            daemon=True,
        ).start()

    return {
        "pid": proc.pid,
        "port": req.port,
        "model_id": req.model_id,
        "gpu": gpu_str,
        "log": str(log_path),
    }


@app.delete("/instances/{port}")
def stop_instance(port: int, deregister: bool = True):
    pid = _get_pid_on_port(port)
    if pid is None:
        raise HTTPException(status_code=404, detail=f"No process found on port {port}")

    # Get served name before killing (for proxy deregistration)
    served_name = None
    try:
        models_data = _http_get(f"http://localhost:{port}/v1/models")
        if models_data and "data" in models_data and models_data["data"]:
            served_name = models_data["data"][0]["id"]
    except Exception:
        pass

    # Kill the process tree
    try:
        proc = psutil.Process(pid)
        children = proc.children(recursive=True)
        for child in children:
            child.send_signal(signal.SIGTERM)
        proc.send_signal(signal.SIGTERM)

        _, alive = psutil.wait_procs([proc] + children, timeout=10)
        for p in alive:
            p.kill()
    except psutil.NoSuchProcess:
        pass

    # Update proxy config to remove stopped instance
    if deregister and served_name:
        threading.Thread(
            target=_proxy_write_and_restart,
            kwargs={"remove_served": served_name},
            daemon=True,
        ).start()

    return {"stopped": True, "port": port, "pid": pid}


def _load_library() -> list[dict]:
    if not LIBRARY_PATH.exists():
        return []
    with open(LIBRARY_PATH) as f:
        return json.load(f)

def _save_library(library: list[dict]):
    with open(LIBRARY_PATH, "w") as f:
        json.dump(library, f, indent=2)


@app.get("/models/library")
def get_model_library():
    """Returns only enabled models (used by Deploy modal)."""
    library = _load_library()
    if not library:
        raise HTTPException(status_code=404, detail="model_library.json not found")
    cached = _cached_model_ids()
    result = []
    for entry in library:
        if entry.get("enabled", True):
            entry = dict(entry)
            entry["cached"] = entry["id"] in cached
            result.append(entry)
    return result


@app.get("/models/library/all")
def get_model_library_all():
    """Returns all models including disabled (used by library manager)."""
    library = _load_library()
    cached = _cached_model_ids()
    result = []
    for entry in library:
        entry = dict(entry)
        entry["cached"] = entry["id"] in cached
        entry.setdefault("enabled", True)
        result.append(entry)
    return result


@app.patch("/models/library/{model_id:path}")
def update_model_entry(model_id: str, body: dict):
    """Update fields on a model entry (e.g. toggle enabled)."""
    library = _load_library()
    idx = next((i for i, m in enumerate(library) if m["id"] == model_id), None)
    if idx is None:
        raise HTTPException(status_code=404, detail=f"Model '{model_id}' not in library")
    # Only allow safe field updates
    allowed = {"enabled", "name", "description", "flags", "vram_gb", "min_gpus",
               "quantization", "max_context", "family", "type"}
    for k, v in body.items():
        if k in allowed:
            library[idx][k] = v
    _save_library(library)
    return library[idx]


@app.post("/models/library")
def add_model_entry(entry: dict):
    """Add a new model to the library."""
    if not entry.get("id"):
        raise HTTPException(status_code=400, detail="id is required")
    library = _load_library()
    if any(m["id"] == entry["id"] for m in library):
        raise HTTPException(status_code=409, detail=f"Model '{entry['id']}' already in library")
    entry.setdefault("enabled", True)
    entry.setdefault("flags", {})
    entry.setdefault("family", "unknown")
    library.append(entry)
    _save_library(library)
    return entry


@app.delete("/models/library/{model_id:path}")
def delete_model_entry(model_id: str):
    """Remove a model from the library."""
    library = _load_library()
    before = len(library)
    library = [m for m in library if m["id"] != model_id]
    if len(library) == before:
        raise HTTPException(status_code=404, detail=f"Model '{model_id}' not in library")
    _save_library(library)
    return {"deleted": model_id}


@app.get("/models/cached")
def get_cached_models():
    return sorted(list(_cached_model_ids()))


# ── HF integration: token, preflight, cache sizes, downloads, importer ──────
# Everything below is per-node. The dashboard composes cross-node views by
# calling each agent in parallel (same pattern as /status).

@app.get("/models/hf/token")
def hf_token_status():
    return models_hf.token_status()


class HFTokenSet(BaseModel):
    token: str


@app.post("/models/hf/token")
def hf_token_set(req: HFTokenSet):
    try:
        models_hf.write_token(req.token)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return models_hf.token_status()


@app.delete("/models/hf/token")
def hf_token_clear():
    models_hf.clear_token()
    return models_hf.token_status()


@app.get("/models/hf/lookup/{model_id:path}")
def hf_lookup(model_id: str):
    """Metadata + auth status for a HF repo. Powers the library importer."""
    return models_hf.lookup_model(model_id)


@app.get("/models/hf/preflight/{model_id:path}")
def hf_preflight(model_id: str):
    """
    Called before launch to kill the silent-HF-gating problem. Returns the same
    payload as lookup; callers should abort if status != 'ok'.
    """
    return models_hf.preflight(model_id)


@app.get("/models/cache")
def get_cache_listing():
    """All cached models with on-disk sizes, biggest first."""
    return models_hf.list_cached()


@app.get("/models/cache/stats")
def get_cache_stats():
    """Total HF cache size + disk headroom so the UI can warn before filling up."""
    return models_hf.cache_stats()


@app.delete("/models/cache/{model_id:path}")
def delete_cache(model_id: str):
    return models_hf.delete_cached(model_id)


class HFDownloadReq(BaseModel):
    model_id: str


@app.post("/models/hf/download")
def hf_download_start(req: HFDownloadReq):
    """
    Kick off a pre-pull. Non-blocking — returns immediately with current state.
    Poll /models/hf/download/{model_id} for progress.
    """
    state = models_hf.MANAGER.start(req.model_id)
    return models_hf.asdict(state) if hasattr(state, "__dataclass_fields__") else state


@app.get("/models/hf/downloads")
def hf_downloads_list():
    """All downloads this agent has tracked since its last start."""
    return models_hf.MANAGER.list()


@app.get("/models/hf/download/{model_id:path}")
def hf_download_status(model_id: str):
    state = models_hf.MANAGER.get(model_id)
    if state is None:
        raise HTTPException(status_code=404, detail="no download tracked for this model")
    return state


@app.delete("/models/hf/download/{model_id:path}")
def hf_download_cancel(model_id: str):
    ok = models_hf.MANAGER.cancel(model_id)
    return {"canceled": ok, "model_id": model_id}


@app.get("/proxy/status")
def get_proxy_status():
    data = _http_get(
        f"{CLUSTER_PROXY_URL}/v1/models",
        headers={"Authorization": f"Bearer {LITELLM_KEY}"}
    )
    if data is None:
        return {"healthy": False, "models": [], "url": CLUSTER_PROXY_URL}

    models = [m["id"] for m in data.get("data", [])]
    return {"healthy": True, "models": models, "url": CLUSTER_PROXY_URL}


@app.post("/proxy/register")
def proxy_register(req: ProxyRegisterRequest):
    """Register a single model with the proxy (adds to config + restarts proxy)."""
    threading.Thread(
        target=_proxy_write_and_restart,
        kwargs={"extra_add": {"served_name": req.served_name, "port": int(req.api_base.split(":")[-1].rstrip("/v1"))}},
        daemon=True,
    ).start()
    return {"queued": True}


@app.post("/proxy/sync")
def proxy_sync():
    """Rebuild the proxy config from all currently running instances and restart."""
    threading.Thread(target=_proxy_write_and_restart, daemon=True).start()
    return {"queued": True}


# ── Stack configuration endpoints ────────────────────────────────────────────

def _load_stack_configs() -> list[dict]:
    if not STACK_CONFIGS_PATH.exists():
        return []
    with open(STACK_CONFIGS_PATH) as f:
        return json.load(f)

def _save_stack_configs(configs: list[dict]):
    with open(STACK_CONFIGS_PATH, "w") as f:
        json.dump(configs, f, indent=2)

def _running_ports() -> set[int]:
    return {inst["port"] for inst in _scan_vllm_instances()}


@app.get("/configs")
def list_configs():
    configs = _load_stack_configs()
    running = _running_ports()
    # Annotate each config with how many of its models are currently running
    for cfg in configs:
        ports = [m["port"] for m in cfg.get("models", [])]
        cfg["running_count"] = sum(1 for p in ports if p in running)
        cfg["total_count"] = len(ports)
    return configs


@app.get("/configs/{name}/preflight")
def config_preflight(name: str):
    """Check whether each model in a config will fit given current free VRAM."""
    configs = _load_stack_configs()
    cfg = next((c for c in configs if c["name"] == name), None)
    if cfg is None:
        raise HTTPException(status_code=404, detail=f"Config '{name}' not found")

    gpus_data = get_gpus()
    gpu_map   = {g["index"]: g for g in gpus_data}
    running   = _running_ports()

    checks = []
    for m in cfg.get("models", []):
        port        = m["port"]
        gpu_indices = m.get("gpu_indices", [])
        util        = float(m.get("gpu_memory_utilization", 0.85))
        already     = port in running

        target_gpus        = [gpu_map[i] for i in gpu_indices if i in gpu_map]
        total_vram_mb      = sum(g["vram_total_mb"] for g in target_gpus)
        free_vram_mb       = sum(g["vram_free_mb"]  for g in target_gpus)
        required_vram_mb   = total_vram_mb * util

        fits = already or (free_vram_mb >= required_vram_mb * 0.95)

        # Suggest GPUs that have enough free VRAM (single-GPU fit only)
        alternatives = []
        if not fits:
            for g in gpus_data:
                if g["index"] not in gpu_indices:
                    needed = g["vram_total_mb"] * util
                    if g["vram_free_mb"] >= needed * 0.95:
                        alternatives.append(g["index"])

        # Suggest a lower utilization that would fit on the target GPU
        suggested_util = None
        if not fits and free_vram_mb > 0 and total_vram_mb > 0:
            safe_util = (free_vram_mb * 0.95) / total_vram_mb
            if safe_util >= 0.20:
                suggested_util = round(safe_util, 2)

        checks.append({
            "served_name":           m["served_name"],
            "model_id":              m["model_id"],
            "port":                  port,
            "gpu_indices":           gpu_indices,
            "gpu_memory_utilization":util,
            "required_vram_gb":      round(required_vram_mb / 1024, 1),
            "available_vram_gb":     round(free_vram_mb / 1024, 1),
            "total_vram_gb":         round(total_vram_mb / 1024, 1),
            "fits":                  fits,
            "already_running":       already,
            "alternative_gpus":      alternatives,
            "suggested_utilization": suggested_util,
        })

    warnings = [
        f"{c['served_name']}: {c['available_vram_gb']}GB free on GPU {c['gpu_indices']}, "
        f"need ~{c['required_vram_gb']}GB"
        for c in checks if not c["fits"] and not c["already_running"]
    ]

    return {"checks": checks, "all_fit": all(c["fits"] for c in checks), "warnings": warnings}


@app.get("/configs/{name}/repack")
def config_repack(name: str):
    """Bin-pack models into GPUs: largest model → largest free space first."""
    configs = _load_stack_configs()
    cfg = next((c for c in configs if c["name"] == name), None)
    if cfg is None:
        raise HTTPException(status_code=404, detail=f"Config '{name}' not found")

    gpus_data  = get_gpus()
    gpu_map    = {g["index"]: g for g in gpus_data}
    running    = _running_ports()

    already_running = [m for m in cfg.get("models", []) if m["port"] in running]
    to_pack         = [m for m in cfg.get("models", []) if m["port"] not in running]

    # Compute absolute VRAM requirement for each model (based on its current target GPU)
    def model_size_mb(m: dict) -> float:
        gpu_indices = m.get("gpu_indices", [])
        util = float(m.get("gpu_memory_utilization", 0.85))
        total_mb = sum(gpu_map[i]["vram_total_mb"] for i in gpu_indices if i in gpu_map)
        return total_mb * util

    # Sort models largest → smallest
    to_pack_sorted = sorted(to_pack, key=model_size_mb, reverse=True)

    # Track simulated free VRAM per GPU
    gpu_free_mb = {idx: g["vram_free_mb"] for idx, g in gpu_map.items()}

    assignments = []
    unsolvable  = []

    for m in to_pack_sorted:
        required_mb = model_size_mb(m)
        original_util = float(m.get("gpu_memory_utilization", 0.85))
        original_gpu  = (m.get("gpu_indices") or [None])[0]

        # Sort GPUs by simulated free VRAM, largest first
        candidates = sorted(gpu_free_mb.items(), key=lambda x: x[1], reverse=True)

        placed = False
        for gpu_idx, free_mb in candidates:
            total_mb = gpu_map[gpu_idx]["vram_total_mb"]

            if free_mb >= required_mb * 0.95:
                # Fits at original utilization
                new_util       = original_util
                alloc_mb       = required_mb
            else:
                # Try lowering utilization to fit
                max_util = (free_mb * 0.95) / total_mb
                if max_util < 0.20:
                    continue
                new_util = round(max_util, 2)
                alloc_mb = total_mb * new_util

            gpu_free_mb[gpu_idx] -= alloc_mb

            changed_gpu  = gpu_idx != original_gpu
            changed_util = abs(new_util - original_util) >= 0.01
            if m["port"] in running:
                status = "already_running"
            elif changed_gpu and changed_util:
                status = "reassigned+adjusted"
            elif changed_gpu:
                status = "reassigned"
            elif changed_util:
                status = "adjusted"
            else:
                status = "unchanged"

            assignments.append({
                "served_name":         m["served_name"],
                "model_id":            m["model_id"],
                "port":                m["port"],
                "original_gpu":        original_gpu,
                "new_gpu":             gpu_idx,
                "original_utilization":original_util,
                "new_utilization":     new_util,
                "vram_required_gb":    round(alloc_mb / 1024, 1),
                "gpu_total_vram_gb":   round(total_mb / 1024, 1),
                "status":              status,
            })
            placed = True
            break

        if not placed:
            unsolvable.append({
                "served_name": m["served_name"],
                "port":        m["port"],
                "required_gb": round(required_mb / 1024, 1),
            })

    for m in already_running:
        gpu_idx = (m.get("gpu_indices") or [None])[0]
        assignments.append({
            "served_name":         m["served_name"],
            "model_id":            m["model_id"],
            "port":                m["port"],
            "original_gpu":        gpu_idx,
            "new_gpu":             gpu_idx,
            "original_utilization":float(m.get("gpu_memory_utilization", 0.85)),
            "new_utilization":     float(m.get("gpu_memory_utilization", 0.85)),
            "vram_required_gb":    None,
            "gpu_total_vram_gb":   None,
            "status":              "already_running",
        })

    assignments.sort(key=lambda x: x["port"])

    return {
        "assignments": assignments,
        "solvable":    len(unsolvable) == 0,
        "unsolvable":  unsolvable,
    }


@app.post("/configs/{name}/repack/apply")
def repack_apply(name: str, body: dict):
    """Write the repacked GPU assignments back to the config, then activate."""
    assignments: list[dict] = body.get("assignments", [])
    configs = _load_stack_configs()
    cfg_idx = next((i for i, c in enumerate(configs) if c["name"] == name), None)
    if cfg_idx is None:
        raise HTTPException(status_code=404, detail=f"Config '{name}' not found")

    # Build lookup: port → assignment
    by_port = {a["port"]: a for a in assignments}

    updated_models = []
    for m in configs[cfg_idx].get("models", []):
        a = by_port.get(m["port"])
        if a and a["status"] != "already_running":
            m = dict(m)
            m["gpu_indices"]           = [a["new_gpu"]]
            m["gpu_memory_utilization"] = a["new_utilization"]
        updated_models.append(m)

    configs[cfg_idx]["models"] = updated_models
    _save_stack_configs(configs)

    # Activate with updated config
    return activate_config(name)


@app.post("/configs")
def save_config(cfg: StackConfig):
    configs = _load_stack_configs()
    # Replace existing config with same name, or append
    configs = [c for c in configs if c["name"] != cfg.name]
    configs.append(cfg.model_dump())
    _save_stack_configs(configs)
    return {"saved": cfg.name}


@app.delete("/configs/{name}")
def delete_config(name: str):
    configs = _load_stack_configs()
    configs = [c for c in configs if c["name"] != name]
    _save_stack_configs(configs)
    return {"deleted": name}


@app.post("/configs/{name}/activate")
def activate_config(name: str):
    configs = _load_stack_configs()
    cfg = next((c for c in configs if c["name"] == name), None)
    if cfg is None:
        raise HTTPException(status_code=404, detail=f"Config '{name}' not found")

    running = _running_ports()
    launched, already_running, failed = [], [], []

    for m in cfg.get("models", []):
        port = m["port"]
        if port in running:
            already_running.append({"port": port, "served_name": m["served_name"]})
            continue
        try:
            req = LaunchRequest(
                model_id=m["model_id"],
                gpu_indices=m["gpu_indices"],
                port=port,
                served_name=m["served_name"],
                register_with_proxy=True,
                extra_flags={
                    **m.get("extra_flags", {}),
                    "gpu_memory_utilization": m.get("gpu_memory_utilization", 0.85),
                },
            )
            result = launch_instance(req)
            launched.append(result)
        except Exception as e:
            failed.append({"port": port, "served_name": m["served_name"], "error": str(e)})

    return {"launched": launched, "already_running": already_running, "failed": failed}


@app.post("/configs/{name}/deactivate")
def deactivate_config(name: str):
    configs = _load_stack_configs()
    cfg = next((c for c in configs if c["name"] == name), None)
    if cfg is None:
        raise HTTPException(status_code=404, detail=f"Config '{name}' not found")

    stopped, not_running, failed = [], [], []
    for m in cfg.get("models", []):
        port = m["port"]
        pid = _get_pid_on_port(port)
        if pid is None:
            not_running.append({"port": port})
            continue
        try:
            result = stop_instance(port)
            stopped.append(result)
        except Exception as e:
            failed.append({"port": port, "error": str(e)})

    return {"stopped": stopped, "not_running": not_running, "failed": failed}


@app.post("/configs/snapshot")
def snapshot_current(body: dict):
    """Save currently running instances as a new named config."""
    name = body.get("name", "Snapshot")
    description = body.get("description", "")
    instances = _scan_vllm_instances()
    if not instances:
        raise HTTPException(status_code=400, detail="No instances currently running to snapshot")

    models = []
    for inst in instances:
        models.append({
            "model_id":              inst.get("model_id") or "",
            "served_name":           inst.get("served_name") or "",
            "gpu_indices":           [inst["gpu_index"]] if inst.get("gpu_index") is not None else [],
            "port":                  inst["port"],
            "gpu_memory_utilization":inst.get("gpu_memory_utilization") or 0.85,
            "extra_flags": {
                k: v for k, v in {
                    "quantization":         inst.get("quantization"),
                    "tensor_parallel_size": inst.get("tensor_parallel_size"),
                    "max_model_len":        inst.get("context_length"),
                    "max_num_seqs":         inst.get("max_num_seqs"),
                }.items() if v is not None
            },
        })

    cfg = StackConfig(name=name, description=description, models=[
        StackModelEntry(**m) for m in models
    ])
    return save_config(cfg)


@app.post("/agent/restart")
def agent_restart():
    """Restart the agent process in-place (picks up code changes)."""
    def _do():
        time.sleep(0.3)
        os.execv(sys.executable, [sys.executable] + sys.argv)
    threading.Thread(target=_do, daemon=True).start()
    return {"restarting": True}


@app.post("/agent/stop")
def agent_stop():
    """Stop the agent process."""
    def _do():
        time.sleep(0.3)
        os.kill(os.getpid(), signal.SIGTERM)
    threading.Thread(target=_do, daemon=True).start()
    return {"stopping": True}


@app.get("/nodes")
def get_nodes():
    """Return the full node list — used by child dashboards to show the whole cluster."""
    try:
        config = json.loads(NODE_CONFIG_PATH.read_text())
        return config.get("nodes", [])
    except Exception:
        return []


class RenameNodeRequest(BaseModel):
    name: str
    # agent_port is optional — scoping the rename to a specific (ip, port) pair
    # disambiguates if two nodes ever shared an IP but different ports.
    agent_port: int | None = None


@app.patch("/nodes/{ip}")
def rename_node(ip: str, req: RenameNodeRequest):
    """
    Rename a node registered in this agent's node_config.json. Intended to be
    called on master/both — child agents have an empty nodes[] and will 404.
    Child-served dashboards proxy through /api/nodes/rename, which forwards
    here using the master IP from local config.
    """
    if not NODE_CONFIG_PATH.exists():
        raise HTTPException(status_code=500, detail="node_config.json not found")
    try:
        config = json.loads(NODE_CONFIG_PATH.read_text())
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"node_config.json unreadable: {e}")

    nodes = config.get("nodes") or []
    for n in nodes:
        if n.get("ip") != ip:
            continue
        if req.agent_port is not None and n.get("agent_port") != req.agent_port:
            continue
        n["name"] = req.name
        config["nodes"] = nodes
        NODE_CONFIG_PATH.write_text(json.dumps(config, indent=2))
        return {"renamed": ip, "name": req.name}
    raise HTTPException(status_code=404, detail=f"Node {ip} not registered here")


DASHBOARD_DIR = Path(__file__).parent.parent / "dashboard"
DASHBOARD_PID_FILE = DASHBOARD_DIR / ".dashboard_pid"


def _dashboard_pid() -> int | None:
    try:
        pid = int(DASHBOARD_PID_FILE.read_text().strip())
        os.kill(pid, 0)  # check alive
        return pid
    except Exception:
        return None


@app.post("/dashboard/restart")
def dashboard_restart():
    """Kill the dashboard, rebuild, and restart it."""
    def _do():
        time.sleep(0.3)
        port = os.environ.get("DASHBOARD_PORT", "3000")

        # Kill by PID file first, then fall back to killing by port
        pid = _dashboard_pid()
        if pid:
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        else:
            # Kill whatever is holding the port (handles manual/node.sh starts)
            try:
                result = subprocess.run(
                    ["lsof", "-ti", f":{port}"], capture_output=True, text=True
                )
                for p in result.stdout.strip().split():
                    try:
                        os.kill(int(p), signal.SIGTERM)
                    except Exception:
                        pass
            except Exception:
                pass

        time.sleep(2)  # wait for port to free

        env = {**os.environ, "PATH": f"/usr/local/bin:/usr/bin:/bin:{os.environ.get('PATH', '')}"}
        log_file = open(DASHBOARD_DIR / "dashboard.log", "w")
        subprocess.run(["npm", "run", "build"], cwd=str(DASHBOARD_DIR), env=env,
                       stdout=log_file, stderr=subprocess.STDOUT)
        log_file.flush()
        proc = subprocess.Popen(
            ["npm", "run", "start"],
            cwd=str(DASHBOARD_DIR),
            env=env,
            stdout=log_file,
            stderr=subprocess.STDOUT,
        )
        DASHBOARD_PID_FILE.write_text(str(proc.pid))
    threading.Thread(target=_do, daemon=True).start()
    return {"restarting": True}


@app.post("/dashboard/stop")
def dashboard_stop():
    """Stop the dashboard process."""
    pid = _dashboard_pid()
    if pid:
        os.kill(pid, signal.SIGTERM)
        DASHBOARD_PID_FILE.unlink(missing_ok=True)
        return {"stopped": True, "pid": pid}
    return {"stopped": False, "detail": "Dashboard not running"}


@app.get("/status")
def get_full_status():
    """All data in a single call — used for dashboard polling."""
    gpus = get_gpus()
    instances = get_instances()
    proxy = get_proxy_status()
    return {
        "gpus": gpus,
        "instances": instances,
        "proxy": proxy,
    }


# ── Startup re-registration ───────────────────────────────────────────────────
# When this agent (re)starts, any vLLM instances that were left running need to
# be re-registered with the cluster proxy. Otherwise a proxy restart or a stale
# registration from a previous boot would leave the proxy's model list out of
# sync with what's actually serving. Runs in the background so startup doesn't
# block on an unreachable proxy.

def _reregister_existing_instances():
    # Let uvicorn bind before we do anything that might take time.
    time.sleep(2)
    try:
        _proxy_write_and_restart()
    except Exception:
        pass


_SAMPLER: MetricsSampler | None = None


@app.on_event("startup")
def _on_startup():
    threading.Thread(target=_reregister_existing_instances, daemon=True).start()

    # Start the per-node metrics sampler. Uses the currently registered node
    # name from node_config.json so JSONL rows are self-describing across
    # nodes. Passing _scan_vllm_instances as the callable avoids duplicating
    # the scan logic — the sampler sees whatever the rest of the agent sees.
    global _SAMPLER
    nodes_cfg = _NODE_CFG.get("nodes") or []
    node_name = None
    for n in nodes_cfg:
        if n.get("ip") == THIS_IP:
            node_name = n.get("name")
            break
    if not node_name:
        node_name = THIS_IP
    _SAMPLER = MetricsSampler(node_name=node_name, list_instances=_scan_vllm_instances)
    _SAMPLER.start()


@app.get("/metrics/query")
def metrics_query(range: str = "24h", resolution: str = "1h"):
    """
    Returns time-bucketed aggregates for this node's GPU and per-model history.
    Ranges: 1h, 6h, 24h, 7d, 30d. Resolutions: 1m, 5m, 15m, 1h, 6h, 1d.
    Dashboard is expected to fetch each node in parallel and combine.
    """
    try:
        return query_metrics(range_key=range, resolution_key=resolution)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"metrics query failed: {e}")


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    port = int(os.environ.get("AGENT_PORT", 5000))
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")
