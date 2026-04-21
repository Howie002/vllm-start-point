"""
HuggingFace integration — token management, pre-pull with progress, cache sizing,
deletion, preflight gating check, and a metadata lookup that powers the library
importer.

Everything here is per-node. Each agent manages its own HF cache and its own
token; the dashboard composes cross-node views by calling each agent.

No SQLite, no external state store — the token lives where huggingface_hub
expects it (`~/.cache/huggingface/token`), downloads track progress in memory,
and disk accounting walks the cache dir on demand.
"""

from __future__ import annotations

import os
import shutil
import threading
import time
from dataclasses import dataclass, asdict, field
from pathlib import Path
from typing import Optional

HF_CACHE  = Path.home() / ".cache" / "huggingface" / "hub"
TOKEN_PATH = Path.home() / ".cache" / "huggingface" / "token"


# ── Token management ─────────────────────────────────────────────────────────

def read_token() -> Optional[str]:
    if not TOKEN_PATH.exists():
        return None
    try:
        t = TOKEN_PATH.read_text().strip()
        return t or None
    except OSError:
        return None


def write_token(token: str) -> None:
    token = token.strip()
    if not token:
        raise ValueError("token is empty")
    TOKEN_PATH.parent.mkdir(parents=True, exist_ok=True)
    TOKEN_PATH.write_text(token)
    try:
        TOKEN_PATH.chmod(0o600)  # Secret — lock file perms.
    except OSError:
        pass


def clear_token() -> None:
    if TOKEN_PATH.exists():
        try:
            TOKEN_PATH.unlink()
        except OSError:
            pass


def token_status() -> dict:
    """Returns presence + a masked preview. Never leaks the full token."""
    t = read_token()
    if not t:
        return {"set": False}
    if len(t) >= 8:
        preview = f"{t[:4]}…{t[-4:]}"
    else:
        preview = "***"
    return {"set": True, "preview": preview}


# ── HF API lookup (powers importer + preflight) ──────────────────────────────

def _hf_api(token: Optional[str] = None):
    from huggingface_hub import HfApi  # lazy import — agent boots fine if HF isn't installed yet
    return HfApi(token=token)


def lookup_model(model_id: str) -> dict:
    """
    Returns metadata and auth status for a HuggingFace repo. The dashboard
    importer uses this to prefill a library entry without manual JSON editing.

    Status values:
      ok                   — model exists and we can read it
      gated_unauthorized   — model exists but is gated and this node doesn't have access
      not_found            — repo doesn't exist (or is private with no token)
      network_error        — transient; retry
    """
    from huggingface_hub.utils import GatedRepoError, RepositoryNotFoundError, HfHubHTTPError
    api = _hf_api(read_token())
    try:
        info = api.model_info(model_id)
    except GatedRepoError as e:
        return {"status": "gated_unauthorized", "message": str(e), "model_id": model_id}
    except RepositoryNotFoundError:
        return {"status": "not_found", "message": f"Repo '{model_id}' not found (or private and this node has no HF token).", "model_id": model_id}
    except HfHubHTTPError as e:
        status_code = getattr(getattr(e, "response", None), "status_code", None)
        if status_code == 401:
            return {"status": "gated_unauthorized", "message": "401 Unauthorized — token missing or insufficient.", "model_id": model_id}
        return {"status": "network_error", "message": str(e), "model_id": model_id}
    except Exception as e:
        return {"status": "network_error", "message": str(e), "model_id": model_id}

    # ── Derive useful fields for the importer ─────────────────────────────────
    card = getattr(info, "cardData", {}) or {}
    pipeline = getattr(info, "pipeline_tag", None) or card.get("pipeline_tag") or ""
    # pipeline_tag → our "type" field
    if "embedding" in pipeline or pipeline == "feature-extraction" or pipeline == "sentence-similarity":
        model_type = "embedding"
    elif "reasoning" in (card.get("tags") or []):
        model_type = "reasoning"
    else:
        model_type = "chat"

    # Total size from safetensors metadata when HF reports it
    total_bytes = 0
    for s in (info.siblings or []):
        if getattr(s, "size", None):
            total_bytes += s.size or 0

    # Rough VRAM estimate: parameters × bytes-per-param (based on quant heuristic).
    # If we can't figure the param count, fall back to on-disk size × 1.25.
    params_b = None
    safetensors_meta = getattr(info, "safetensors", None)
    if safetensors_meta and safetensors_meta.parameters:
        params_b = sum(safetensors_meta.parameters.values()) / 1e9
    # Heuristic quant: if the repo mentions fp8/int4/int8 in name or tags
    name_lower = (model_id + " " + " ".join(card.get("tags") or [])).lower()
    if "fp8" in name_lower:   quant, bytes_per_param = "fp8", 1
    elif "int4" in name_lower or "awq" in name_lower or "gptq" in name_lower: quant, bytes_per_param = "int4", 0.5
    elif "int8" in name_lower: quant, bytes_per_param = "int8", 1
    else: quant, bytes_per_param = "bf16", 2

    if params_b:
        vram_gb = max(1, round(params_b * bytes_per_param * 1.15))  # +15% for activations/KV
    elif total_bytes:
        vram_gb = max(1, round(total_bytes / (1024 ** 3) * 1.25))
    else:
        vram_gb = None

    context_length = None
    cfg = card.get("config") or {}
    for k in ("max_position_embeddings", "max_sequence_length", "n_positions"):
        if k in cfg:
            context_length = cfg[k]
            break

    return {
        "status":           "ok",
        "model_id":         model_id,
        "gated":            getattr(info, "gated", False) is not False,
        "pipeline_tag":     pipeline,
        "type":             model_type,
        "params_b":         round(params_b, 2) if params_b else None,
        "total_bytes":      total_bytes,
        "vram_gb_estimate": vram_gb,
        "quant_guess":      quant,
        "context_length":   context_length,
        "tags":             card.get("tags") or [],
        "license":          card.get("license"),
    }


def preflight(model_id: str) -> dict:
    """
    Can this node actually pull this repo? `model_info` returns metadata for
    gated repos even without auth — only file downloads are blocked — so we
    need `auth_check` to catch gated-and-unauthorized for real.
    """
    info = lookup_model(model_id)
    if info["status"] != "ok":
        return info

    if info.get("gated"):
        from huggingface_hub.utils import GatedRepoError, RepositoryNotFoundError, HfHubHTTPError
        api = _hf_api(read_token())
        try:
            api.auth_check(model_id)
            info["gated_but_authorized"] = True
        except GatedRepoError as e:
            return {"status": "gated_unauthorized", "message": str(e), "model_id": model_id, "gated": True}
        except RepositoryNotFoundError:
            return {"status": "not_found", "message": f"Repo '{model_id}' not found or token lacks read access.", "model_id": model_id}
        except HfHubHTTPError as e:
            status_code = getattr(getattr(e, "response", None), "status_code", None)
            if status_code == 401:
                return {"status": "gated_unauthorized", "message": "401 Unauthorized — token missing or insufficient.", "model_id": model_id, "gated": True}
            return {"status": "network_error", "message": str(e), "model_id": model_id}
        except Exception as e:
            return {"status": "network_error", "message": str(e), "model_id": model_id}

    return info


# ── Cache listing + size accounting ──────────────────────────────────────────

def _cache_dir_for(model_id: str) -> Path:
    return HF_CACHE / ("models--" + model_id.replace("/", "--"))


def _dir_size_bytes(path: Path) -> int:
    total = 0
    try:
        for p in path.rglob("*"):
            try:
                if p.is_file() and not p.is_symlink():
                    total += p.stat().st_size
            except OSError:
                pass
    except OSError:
        pass
    return total


def list_cached() -> list[dict]:
    """All cached models with on-disk sizes. Walks each dir — a few ms per model."""
    out = []
    if not HF_CACHE.exists():
        return out
    for d in HF_CACHE.iterdir():
        if not (d.is_dir() and d.name.startswith("models--")):
            continue
        parts = d.name[len("models--"):].split("--", 1)
        if len(parts) != 2:
            continue
        size = _dir_size_bytes(d)
        out.append({
            "model_id":   f"{parts[0]}/{parts[1]}",
            "size_bytes": size,
            "path":       str(d),
        })
    out.sort(key=lambda x: -x["size_bytes"])
    return out


def cache_stats() -> dict:
    cache_used = _dir_size_bytes(HF_CACHE) if HF_CACHE.exists() else 0
    try:
        total, used, free = shutil.disk_usage(Path.home())
    except OSError:
        total = used = free = 0
    return {
        "cache_used_bytes": cache_used,
        "disk_total_bytes": total,
        "disk_used_bytes":  used,
        "disk_free_bytes":  free,
        "cache_path":       str(HF_CACHE),
    }


def delete_cached(model_id: str) -> dict:
    target = _cache_dir_for(model_id)
    if not target.exists():
        return {"deleted": False, "reason": "not cached"}
    size = _dir_size_bytes(target)
    shutil.rmtree(target, ignore_errors=True)
    return {"deleted": True, "model_id": model_id, "bytes_freed": size}


# ── Pre-pull with progress ───────────────────────────────────────────────────

@dataclass
class DownloadState:
    model_id:      str
    state:         str                  # pending | downloading | complete | error | canceled
    bytes_done:    int   = 0
    bytes_total:   int   = 0             # 0 if we couldn't determine up front
    started_at:    float = field(default_factory=time.time)
    finished_at:   Optional[float] = None
    error:         Optional[str] = None


class DownloadManager:
    """
    Singleton per-agent. Tracks in-memory; cleared on agent restart (which is
    acceptable — the actual downloaded files remain on disk).

    Uses snapshot_download in a background thread; a watcher thread polls the
    cache dir size every 2s so the UI can draw a progress bar. If HF reports
    the total size up front (from siblings metadata), the bar is accurate;
    otherwise we show absolute bytes and leave % off.
    """

    def __init__(self):
        self._state: dict[str, DownloadState] = {}
        self._threads: dict[str, threading.Thread] = {}
        self._lock = threading.Lock()

    def start(self, model_id: str) -> DownloadState:
        with self._lock:
            existing = self._state.get(model_id)
            if existing and existing.state in ("pending", "downloading"):
                return existing
            s = DownloadState(model_id=model_id, state="pending")
            self._state[model_id] = s

        # Compute expected size out-of-band (does a network call — keep outside lock)
        try:
            meta = lookup_model(model_id)
            if meta["status"] != "ok":
                with self._lock:
                    s.state = "error"
                    s.error = meta.get("message", meta["status"])
                    s.finished_at = time.time()
                return s
            s.bytes_total = int(meta.get("total_bytes") or 0)
        except Exception as e:
            with self._lock:
                s.state = "error"
                s.error = f"preflight failed: {e}"
                s.finished_at = time.time()
            return s

        # Spawn downloader + watcher
        t = threading.Thread(target=self._run, args=(s,), daemon=True, name=f"dl-{model_id}")
        self._threads[model_id] = t
        t.start()
        return s

    def _run(self, s: DownloadState) -> None:
        from huggingface_hub import snapshot_download
        target_dir = _cache_dir_for(s.model_id)
        stop_watch = threading.Event()

        def _watch():
            while not stop_watch.wait(2.0):
                if target_dir.exists():
                    s.bytes_done = _dir_size_bytes(target_dir)

        watcher = threading.Thread(target=_watch, daemon=True, name=f"watch-{s.model_id}")
        watcher.start()

        s.state = "downloading"
        try:
            snapshot_download(
                repo_id=s.model_id,
                token=read_token(),
                # `HF_HUB_ENABLE_HF_TRANSFER` would speed this up but we skip the
                # extra dep; huggingface_hub falls back to plain HTTPS.
            )
            s.state = "complete"
            # Final size from disk in case the watcher missed the tail
            s.bytes_done = _dir_size_bytes(target_dir)
            if not s.bytes_total:
                s.bytes_total = s.bytes_done  # backfill so % shows 100
        except Exception as e:
            s.state = "error"
            s.error = str(e)
        finally:
            stop_watch.set()
            s.finished_at = time.time()

    def cancel(self, model_id: str) -> bool:
        """
        Soft cancel — we can't interrupt snapshot_download cleanly, but we can
        mark the state so the UI stops polling. Partial data is preserved on
        disk and will resume on the next .start().
        """
        with self._lock:
            s = self._state.get(model_id)
            if not s or s.state not in ("pending", "downloading"):
                return False
            s.state = "canceled"
            s.finished_at = time.time()
            return True

    def get(self, model_id: str) -> Optional[dict]:
        s = self._state.get(model_id)
        if not s:
            return None
        return asdict(s)

    def list(self) -> list[dict]:
        return [asdict(s) for s in self._state.values()]


MANAGER = DownloadManager()
