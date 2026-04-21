"""
Per-node metrics sampler + query layer.

Design:
  - A background thread on the agent samples every 60s:
      * GPU stats from nvidia-smi (util, VRAM, temp)
      * Per-vLLM-instance stats from each instance's /metrics (Prometheus text)
  - Each sample is appended to two JSONL files, one per "kind":
      logs/metrics/gpu-YYYY-MM-DD.jsonl
      logs/metrics/model-YYYY-MM-DD.jsonl
    (Split by kind so DuckDB queries don't have to filter, and schemas stay flat.)
  - Files rotate daily by filename.
  - Files older than METRICS_RETENTION_DAYS are pruned on each write.

Queries:
  - DuckDB reads the JSONL files directly — no staging, no schema migrations.
  - time_bucket() rolls minute-level rows up to any resolution requested.
  - Each agent serves its own data via /metrics/query. The dashboard hits every
    agent in parallel and composes cluster-wide views client-side.

Bucket-based percentiles:
  - TTFT percentiles are computed from vLLM's histogram buckets. These are
    approximate (resolution limited by bucket granularity) but good enough to
    spot drift. We store p50/p95 directly in each sample so queries stay cheap.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import threading
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

# ── Config ────────────────────────────────────────────────────────────────────

METRICS_DIR          = Path(__file__).parent.parent / "logs" / "metrics"
METRICS_DIR.mkdir(parents=True, exist_ok=True)
SAMPLE_INTERVAL_S    = 60
METRICS_RETENTION_DAYS = 30

# ── Prometheus text parser ────────────────────────────────────────────────────
# Minimal — only handles what vLLM/LiteLLM emit. No aggregation logic; we just
# pull out named metrics and their labels as a flat list of (name, labels, value).

_SAMPLE_RE = re.compile(r"^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+([-+Ee0-9.nNaAiIfF]+)")
_LABEL_RE  = re.compile(r'([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"')


def _parse_prom(text: str) -> list[tuple[str, dict, float]]:
    out: list[tuple[str, dict, float]] = []
    for line in text.splitlines():
        if not line or line[0] == "#":
            continue
        m = _SAMPLE_RE.match(line)
        if not m:
            continue
        name, lab_str, val_str = m.group(1), m.group(2) or "", m.group(3)
        try:
            val = float(val_str)
        except ValueError:
            continue
        labels = {k: v for k, v in _LABEL_RE.findall(lab_str)}
        out.append((name, labels, val))
    return out


def _sum_by_model(samples, name: str) -> dict[str, float]:
    """Sum a counter across all label combos, grouped by model_name label."""
    out: dict[str, float] = {}
    for n, labels, val in samples:
        if n != name:
            continue
        mn = labels.get("model_name")
        if not mn:
            continue
        out[mn] = out.get(mn, 0.0) + val
    return out


def _histogram_percentile(samples, name_prefix: str, model_name: str, percentile: float) -> Optional[float]:
    """
    Approximate a percentile from a Prometheus histogram (the _bucket family).
    percentile is 0..1. Returns the upper bound of the bucket that crosses the
    threshold (standard "cumulative bucket" convention).
    """
    # Collect (le, value) pairs for this model
    pairs: list[tuple[float, float]] = []
    for n, labels, val in samples:
        if n != f"{name_prefix}_bucket":
            continue
        if labels.get("model_name") != model_name:
            continue
        le = labels.get("le")
        if le is None:
            continue
        try:
            le_f = float("inf") if le == "+Inf" else float(le)
        except ValueError:
            continue
        pairs.append((le_f, val))
    if not pairs:
        return None
    pairs.sort(key=lambda x: x[0])
    total = pairs[-1][1]
    if total <= 0:
        return None
    target = total * percentile
    for le_f, cum in pairs:
        if cum >= target:
            return None if le_f == float("inf") else le_f
    return None


# ── nvidia-smi GPU sample ─────────────────────────────────────────────────────

def _sample_gpus() -> list[dict]:
    """
    Returns one dict per GPU with (idx, util_pct, vram_used_mb, vram_total_mb,
    temp_c, power_w, pids). Unified-memory cards report N/A for VRAM; we fall
    back to system memory for those.
    """
    try:
        raw = subprocess.run(
            ["nvidia-smi",
             "--query-gpu=index,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5,
        ).stdout
    except Exception:
        return []

    gpus: dict[int, dict] = {}
    for line in raw.strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 6:
            continue
        try:
            idx = int(parts[0])
        except ValueError:
            continue
        def _num(s: str) -> Optional[float]:
            try:
                return float(s)
            except ValueError:
                return None
        gpus[idx] = {
            "idx":            idx,
            "util_pct":       _num(parts[1]),
            "vram_used_mb":   _num(parts[2]),
            "vram_total_mb":  _num(parts[3]),
            "temp_c":         _num(parts[4]),
            "power_w":        _num(parts[5]),
            "pids":           [],
        }

    # Per-process GPU PIDs (via uuid → idx)
    try:
        uuids = subprocess.run(
            ["nvidia-smi", "--query-gpu=index,uuid", "--format=csv,noheader"],
            capture_output=True, text=True, timeout=5,
        ).stdout
        uuid_to_idx: dict[str, int] = {}
        for line in uuids.strip().splitlines():
            p = [x.strip() for x in line.split(",")]
            if len(p) == 2:
                uuid_to_idx[p[1]] = int(p[0])

        procs = subprocess.run(
            ["nvidia-smi", "--query-compute-apps=pid,gpu_uuid", "--format=csv,noheader"],
            capture_output=True, text=True, timeout=5,
        ).stdout
        for line in procs.strip().splitlines():
            p = [x.strip() for x in line.split(",")]
            if len(p) >= 2:
                try:
                    pid = int(p[0])
                except ValueError:
                    continue
                idx = uuid_to_idx.get(p[1])
                if idx is not None and idx in gpus:
                    gpus[idx]["pids"].append(pid)
    except Exception:
        pass

    return list(gpus.values())


# ── Per-model sample from vLLM /metrics ──────────────────────────────────────

def _sample_model_for_instance(port: int, served_name: str, gpu_idx: Optional[int]) -> Optional[dict]:
    try:
        with urllib.request.urlopen(f"http://localhost:{port}/metrics", timeout=3) as r:
            text = r.read().decode("utf-8", errors="replace")
    except Exception:
        return None

    parsed = _parse_prom(text)

    def _model_val(name: str) -> float:
        return _sum_by_model(parsed, name).get(served_name, 0.0)

    ttft_p50 = _histogram_percentile(parsed, "vllm:time_to_first_token_seconds", served_name, 0.50)
    ttft_p95 = _histogram_percentile(parsed, "vllm:time_to_first_token_seconds", served_name, 0.95)

    return {
        "served_name":             served_name,
        "port":                    port,
        "gpu_idx":                 gpu_idx,
        "running":                 int(_model_val("vllm:num_requests_running")),
        "waiting":                 int(_model_val("vllm:num_requests_waiting")),
        "prompt_tokens_total":     int(_model_val("vllm:prompt_tokens_total")),
        "generation_tokens_total": int(_model_val("vllm:generation_tokens_total")),
        "requests_success_total":  int(_model_val("vllm:request_success_total")),
        # TTFT is in seconds — convert to ms for display convenience.
        "ttft_p50_ms":             round(ttft_p50 * 1000, 1) if ttft_p50 is not None else None,
        "ttft_p95_ms":             round(ttft_p95 * 1000, 1) if ttft_p95 is not None else None,
    }


# ── JSONL write + daily rotation + retention ─────────────────────────────────

def _day_path(kind: str, dt: datetime) -> Path:
    return METRICS_DIR / f"{kind}-{dt.strftime('%Y-%m-%d')}.jsonl"


def _append_jsonl(path: Path, row: dict) -> None:
    with open(path, "a") as f:
        f.write(json.dumps(row, separators=(",", ":")) + "\n")


def _prune_old_files() -> None:
    cutoff = datetime.now(timezone.utc).date() - timedelta(days=METRICS_RETENTION_DAYS)
    for f in METRICS_DIR.glob("*.jsonl"):
        # Expected: <kind>-YYYY-MM-DD.jsonl
        m = re.match(r"^[a-z]+-(\d{4}-\d{2}-\d{2})\.jsonl$", f.name)
        if not m:
            continue
        try:
            day = datetime.strptime(m.group(1), "%Y-%m-%d").date()
        except ValueError:
            continue
        if day < cutoff:
            try:
                f.unlink()
            except OSError:
                pass


# ── Sampler thread ────────────────────────────────────────────────────────────

class MetricsSampler:
    """
    Drop into the agent. Pass a callable that returns the currently running
    vLLM instances (so we don't duplicate the scan logic). Each instance is
    expected to be a dict with at least port, served_name, and gpu_index.
    """

    def __init__(self, node_name: str, list_instances):
        self.node_name     = node_name
        self.list_instances = list_instances
        self._stop         = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        t = threading.Thread(target=self._run, daemon=True, name="metrics-sampler")
        self._thread = t
        t.start()

    def stop(self) -> None:
        self._stop.set()

    def _run(self) -> None:
        # First sample immediately so the dashboard has *something* to show
        # within a minute of agent start.
        self._sample_once()
        while not self._stop.wait(SAMPLE_INTERVAL_S):
            try:
                self._sample_once()
            except Exception:
                # Never let a sampling hiccup kill the thread.
                pass

    def _sample_once(self) -> None:
        ts = int(time.time())
        now_dt = datetime.now(timezone.utc)

        gpus = _sample_gpus()
        try:
            instances = self.list_instances() or []
        except Exception:
            instances = []

        # Build a pid → gpu_idx map for enrichment
        pid_to_gpu: dict[int, int] = {}
        for g in gpus:
            for pid in g.get("pids", []):
                pid_to_gpu[pid] = g["idx"]

        # active_model_names per GPU — populated after we know model↔gpu
        gpu_active: dict[int, list[str]] = {g["idx"]: [] for g in gpus}

        gpu_path   = _day_path("gpu",   now_dt)
        model_path = _day_path("model", now_dt)

        # Per-model rows first, so we can annotate GPU rows with who's on them
        for inst in instances:
            port    = inst.get("port")
            served  = inst.get("served_name")
            gpu_idx = inst.get("gpu_index")
            if gpu_idx is None:
                pid = inst.get("pid")
                gpu_idx = pid_to_gpu.get(pid) if pid is not None else None
            if port is None or not served:
                continue
            row = _sample_model_for_instance(port, served, gpu_idx)
            if row is None:
                continue
            row["ts"]   = ts
            row["node"] = self.node_name
            _append_jsonl(model_path, row)
            if gpu_idx is not None and gpu_idx in gpu_active:
                gpu_active[gpu_idx].append(served)

        # GPU rows
        for g in gpus:
            models = gpu_active.get(g["idx"], [])
            row = {
                "ts":                ts,
                "node":              self.node_name,
                "idx":               g["idx"],
                "util_pct":          g.get("util_pct"),
                "vram_used_mb":      g.get("vram_used_mb"),
                "vram_total_mb":     g.get("vram_total_mb"),
                "temp_c":            g.get("temp_c"),
                "power_w":           g.get("power_w"),
                "active_models":     models,
                "coresident":        len(models) > 1,
            }
            _append_jsonl(gpu_path, row)

        _prune_old_files()


# ── DuckDB-backed query ──────────────────────────────────────────────────────
# Imported lazily so agent startup doesn't fail if the wheel isn't present.

_DUCKDB = None

def _duck():
    global _DUCKDB
    if _DUCKDB is None:
        import duckdb  # noqa: WPS433
        _DUCKDB = duckdb
    return _DUCKDB


_RESOLUTIONS = {
    "1m":  "1 minute",
    "5m":  "5 minutes",
    "15m": "15 minutes",
    "1h":  "1 hour",
    "6h":  "6 hours",
    "1d":  "1 day",
}

_RANGES = {
    "1h":  timedelta(hours=1),
    "6h":  timedelta(hours=6),
    "24h": timedelta(hours=24),
    "7d":  timedelta(days=7),
    "30d": timedelta(days=30),
}


def query_metrics(range_key: str = "24h", resolution_key: str = "1h") -> dict:
    """
    Return time-bucketed aggregates for both GPU and per-model rows.
    Per-node — the caller composes cluster-wide views.
    """
    rng = _RANGES.get(range_key, _RANGES["24h"])
    res = _RESOLUTIONS.get(resolution_key, _RESOLUTIONS["1h"])
    since_ts = int(time.time() - rng.total_seconds())

    # Files to scan. DuckDB's read_json accepts a glob.
    gpu_glob   = str(METRICS_DIR / "gpu-*.jsonl")
    model_glob = str(METRICS_DIR / "model-*.jsonl")

    duck = _duck()
    con  = duck.connect(":memory:")

    def _empty(name: str) -> bool:
        # DuckDB's read_json errors out on empty glob; pre-flight with file list.
        pattern = name.replace(str(METRICS_DIR) + "/", "")
        return not list(METRICS_DIR.glob(pattern))

    def _rows(cur) -> list[dict]:
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]

    gpu_rows: list[dict]   = []
    model_rows: list[dict] = []

    # Explicit CASTs throughout — read_json_auto types nullable columns as JSON
    # when some rows carry nulls (e.g. unified-memory VRAM, TTFT before traffic).
    if not _empty(gpu_glob):
        try:
            gpu_rows = _rows(con.execute(f"""
                SELECT
                  CAST(extract('epoch' FROM time_bucket(INTERVAL '{res}', to_timestamp(ts))) AS BIGINT) AS bucket_ts,
                  CAST(idx AS INTEGER) AS gpu_idx,
                  AVG(CAST(util_pct AS DOUBLE))                              AS util_pct_avg,
                  QUANTILE_CONT(CAST(util_pct AS DOUBLE), 0.95)              AS util_pct_p95,
                  AVG(CAST(vram_used_mb AS DOUBLE))                          AS vram_used_mb_avg,
                  MAX(CAST(vram_used_mb AS DOUBLE))                          AS vram_used_mb_max,
                  AVG(CASE WHEN CAST(coresident AS BOOLEAN) THEN 1.0 ELSE 0.0 END) * 100 AS coresident_pct,
                  AVG(CAST(power_w AS DOUBLE))                               AS power_w_avg,
                  AVG(CAST(temp_c AS DOUBLE))                                AS temp_c_avg
                FROM read_json_auto('{gpu_glob}')
                WHERE ts >= {since_ts}
                GROUP BY bucket_ts, idx
                ORDER BY bucket_ts, idx
            """))
        except Exception as e:
            gpu_rows = [{"_error": str(e)}]

    if not _empty(model_glob):
        try:
            model_rows = _rows(con.execute(f"""
                WITH raw AS (
                  SELECT
                    CAST(extract('epoch' FROM time_bucket(INTERVAL '{res}', to_timestamp(ts))) AS BIGINT) AS bucket_ts,
                    served_name,
                    CAST(gpu_idx AS INTEGER) AS gpu_idx,
                    MIN(CAST(prompt_tokens_total     AS BIGINT)) AS pt_min,
                    MAX(CAST(prompt_tokens_total     AS BIGINT)) AS pt_max,
                    MIN(CAST(generation_tokens_total AS BIGINT)) AS gt_min,
                    MAX(CAST(generation_tokens_total AS BIGINT)) AS gt_max,
                    MIN(CAST(requests_success_total  AS BIGINT)) AS rs_min,
                    MAX(CAST(requests_success_total  AS BIGINT)) AS rs_max,
                    AVG(CAST(running                 AS DOUBLE)) AS running_avg,
                    MAX(CAST(running                 AS INTEGER)) AS running_max,
                    AVG(CAST(waiting                 AS DOUBLE)) AS waiting_avg,
                    MAX(CAST(waiting                 AS INTEGER)) AS waiting_max,
                    AVG(CAST(ttft_p50_ms             AS DOUBLE)) AS ttft_p50_ms_avg,
                    AVG(CAST(ttft_p95_ms             AS DOUBLE)) AS ttft_p95_ms_avg
                  FROM read_json_auto('{model_glob}')
                  WHERE ts >= {since_ts}
                  GROUP BY bucket_ts, served_name, gpu_idx
                )
                SELECT
                  bucket_ts,
                  served_name,
                  gpu_idx,
                  GREATEST(pt_max - pt_min, 0) AS prompt_tokens,
                  GREATEST(gt_max - gt_min, 0) AS generation_tokens,
                  GREATEST(rs_max - rs_min, 0) AS requests,
                  running_avg, running_max,
                  waiting_avg, waiting_max,
                  ttft_p50_ms_avg, ttft_p95_ms_avg
                FROM raw
                ORDER BY bucket_ts, served_name
            """))
        except Exception as e:
            model_rows = [{"_error": str(e)}]

    con.close()

    return {
        "range":      range_key,
        "resolution": resolution_key,
        "since_ts":   since_ts,
        "gpus":       gpu_rows,
        "models":     model_rows,
    }
