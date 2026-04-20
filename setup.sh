#!/bin/bash
# =============================================================================
#  setup.sh — Create venv (if needed) and install / update all dependencies
#
#  Safe to run repeatedly — skips work that is already done.
#  Called automatically by node.sh for child/both roles.
#
#  The venv lives at ~/.vllm-venv (no spaces in path) because nvcc/flashinfer
#  JIT compilation breaks when include paths contain spaces.
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$HOME/.vllm-venv"
REQUIREMENTS="$SCRIPT_DIR/requirements.txt"

# ── Helpers ───────────────────────────────────────────────────────────────────

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

ok()   { echo -e "  ${GREEN}✓${NC}  $1"; }
warn() { echo -e "  ${YELLOW}!${NC}  $1"; }
err()  { echo -e "  ${RED}✗${NC}  $1"; }
step() { echo -e "\n${YELLOW}▶${NC}  $1"; }

# ── System tools ──────────────────────────────────────────────────────────────

step "Checking system dependencies..."

MISSING_TOOLS=()
for tool in curl wget lsof; do
    command -v "$tool" &>/dev/null || MISSING_TOOLS+=("$tool")
done

if [ ${#MISSING_TOOLS[@]} -gt 0 ]; then
    echo "  Installing missing tools: ${MISSING_TOOLS[*]}"
    if sudo -n apt-get install -y -qq "${MISSING_TOOLS[@]}" 2>/dev/null; then
        ok "Installed: ${MISSING_TOOLS[*]}"
    else
        warn "Could not auto-install ${MISSING_TOOLS[*]} — run: sudo apt-get install -y ${MISSING_TOOLS[*]}"
    fi
fi
ok "System tools checked"

# ── Detect architecture and CUDA driver version ───────────────────────────────

ARCH=$(uname -m)
ok "Architecture: $ARCH"

# Add common CUDA paths so nvcc is findable
for CUDA_PATH in /usr/local/cuda/bin /usr/local/cuda-12.8/bin /usr/local/cuda-12/bin /usr/local/cuda-13/bin; do
    [ -d "$CUDA_PATH" ] && [[ ":$PATH:" != *":$CUDA_PATH:"* ]] && export PATH="$CUDA_PATH:$PATH"
done

# ── NVIDIA driver + CUDA check ────────────────────────────────────────────────

step "Checking GPU environment..."

if ! command -v nvidia-smi &>/dev/null; then
    err "nvidia-smi not found — NVIDIA drivers may not be installed."
    exit 1
fi

GPU_COUNT=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | wc -l)
if [ "$GPU_COUNT" -lt 1 ]; then
    err "No GPUs detected by nvidia-smi."
    exit 1
fi
ok "$GPU_COUNT GPU(s) detected"

# Print GPU list — handle "Not Supported" memory fields (unified memory hardware)
nvidia-smi --query-gpu=index,name,memory.total --format=csv,noheader 2>/dev/null \
    | tr -d '\r' \
    | while IFS=, read -r idx name mem; do
        idx=$(echo "$idx" | xargs)
        name=$(echo "$name" | xargs)
        mem=$(echo "$mem" | xargs)
        case "${mem,,}" in
            "not supported"|"[n/a]"|"n/a"|"") mem="unified memory" ;;
        esac
        echo "       GPU $idx: $name ($mem)"
    done

# Driver-reported CUDA version (what the installed driver supports)
CUDA_DRIVER_VER=$(nvidia-smi 2>/dev/null | grep -oP "CUDA Version: \K[\d.]+" | head -1 || echo "unknown")
CUDA_MAJOR=$(echo "$CUDA_DRIVER_VER" | cut -d. -f1)
ok "Driver CUDA version: $CUDA_DRIVER_VER"

# ── CUDA toolkit (nvcc) — needed for vLLM JIT ─────────────────────────────────

if ! command -v nvcc &>/dev/null; then
    warn "nvcc not found — attempting to install cuda-toolkit-12-8..."
    if command -v apt-get &>/dev/null; then
        if ! apt-cache show cuda-toolkit-12-8 &>/dev/null 2>&1; then
            info "Adding NVIDIA package repository..."
            wget -q https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2404/x86_64/cuda-keyring_1.1-1_all.deb \
                || { warn "Could not download NVIDIA keyring — install cuda-toolkit manually."; }
            sudo dpkg -i cuda-keyring_1.1-1_all.deb 2>/dev/null
            sudo apt-get update -qq 2>/dev/null
            rm -f cuda-keyring_1.1-1_all.deb
        fi
        sudo apt-get install -y cuda-toolkit-12-8 2>/dev/null \
            || warn "cuda-toolkit-12-8 install failed — see https://developer.nvidia.com/cuda-downloads"
    else
        warn "Cannot auto-install CUDA toolkit — install cuda-toolkit-12-8 manually."
    fi
else
    NVCC_VER=$(nvcc --version 2>/dev/null | grep -oP "release \K[\d.]+" | head -1)
    ok "nvcc found (CUDA $NVCC_VER)"
fi

# ── Python check ──────────────────────────────────────────────────────────────

step "Checking Python environment..."

if ! command -v python3 &>/dev/null; then
    err "python3 not found — run: sudo apt install python3 python3-venv"
    exit 1
fi

PYTHON_VERSION=$(python3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
PYTHON_MAJOR=$(echo "$PYTHON_VERSION" | cut -d. -f1)
PYTHON_MINOR=$(echo "$PYTHON_VERSION" | cut -d. -f2)

if [ "$PYTHON_MAJOR" -lt 3 ] || { [ "$PYTHON_MAJOR" -eq 3 ] && [ "$PYTHON_MINOR" -lt 10 ]; }; then
    err "Python $PYTHON_VERSION detected — 3.10+ required."
    exit 1
fi
ok "Python $PYTHON_VERSION"

if ! python3 -m venv --help &>/dev/null; then
    err "python3-venv not found — run: sudo apt install python3-venv python3-full"
    exit 1
fi

# ── Create venv ───────────────────────────────────────────────────────────────

step "Checking virtual environment..."

if [ ! -d "$VENV_DIR" ]; then
    python3 -m venv "$VENV_DIR"
    ok "Virtual environment created at $VENV_DIR"
else
    ok "Virtual environment exists at $VENV_DIR"
fi

PIP="$VENV_DIR/bin/pip"
PYTHON="$VENV_DIR/bin/python"

"$PIP" install --upgrade pip --quiet

# ── Select pip index based on arch + CUDA version ────────────────────────────

step "Selecting PyTorch/vLLM wheel index..."

# Extra index URLs to pass to pip
EXTRA_INDICES=()

if [ "$ARCH" = "aarch64" ]; then
    # aarch64: download.pytorch.org/whl/cu124 has no aarch64 wheels.
    # cu130 index carries aarch64 CUDA wheels; vllm.ai has official aarch64 builds (v0.10.2+).
    echo -e "  ${CYAN}aarch64 detected — using cu130 index + vllm.ai wheels${NC}"
    echo "  (DGX Spark / Grace Blackwell: SM121 uses SM120 forward-compatibility)"
    EXTRA_INDICES+=(
        "https://download.pytorch.org/whl/cu130"
        "https://wheels.vllm.ai/nightly/cu130/"
    )
elif [ "$CUDA_MAJOR" = "13" ] 2>/dev/null; then
    # x86_64 + CUDA 13.x driver: cu130 wheels not yet stable, use cu128
    echo "  CUDA 13 driver on x86_64 — using cu128 index"
    EXTRA_INDICES+=("https://download.pytorch.org/whl/cu128")
else
    # x86_64 + CUDA ≤12: standard cu124 index
    EXTRA_INDICES+=("https://download.pytorch.org/whl/cu124")
fi

for idx in "${EXTRA_INDICES[@]}"; do
    ok "Index: $idx"
done

# ── Install / update packages ─────────────────────────────────────────────────

step "Installing / updating packages from requirements.txt..."

if [ ! -f "$REQUIREMENTS" ]; then
    err "requirements.txt not found at $REQUIREMENTS"
    exit 1
fi

# Build the extra-index-url flags
EXTRA_FLAGS=()
for idx in "${EXTRA_INDICES[@]}"; do
    EXTRA_FLAGS+=(--extra-index-url "$idx")
done

# First pass: visible output
"$PIP" install "${EXTRA_FLAGS[@]}" -r "$REQUIREMENTS" \
    2>&1 | tr -d '\r' | while IFS= read -r line; do
        if echo "$line" | grep -qiE "^error|^fatal|could not find a version|no matching distribution"; then
            err "$line"
        elif echo "$line" | grep -qiE "^successfully installed"; then
            ok "$line"
        elif echo "$line" | grep -qiE "already satisfied"; then
            : # suppress noise
        else
            echo "     $line"
        fi
    done

# Second pass: capture exit code (pipe above masks it)
"$PIP" install "${EXTRA_FLAGS[@]}" -r "$REQUIREMENTS" --quiet 2>&1
PIP_EXIT=$?

if [ $PIP_EXIT -ne 0 ]; then
    err "pip install failed (exit $PIP_EXIT) — check output above."
    exit 1
fi

# ── Verify critical imports ───────────────────────────────────────────────────

step "Verifying installs..."

check_import() {
    local pkg=$1
    local import_name=${2:-$1}
    if "$PYTHON" -c "import $import_name" 2>/dev/null; then
        VERSION=$("$PYTHON" -c "
import $import_name, importlib.metadata
try:
    print(importlib.metadata.version('$pkg'))
except Exception:
    print(getattr($import_name, '__version__', 'unknown'))
" 2>/dev/null || echo "unknown")
        ok "$pkg $VERSION"
    else
        err "$pkg import failed — check pip output above"
        return 1
    fi
}

FAILED=0
check_import "vllm"              || FAILED=1
check_import "litellm"           || FAILED=1
check_import "huggingface_hub"   || FAILED=1
check_import "torch"             || FAILED=1

if [ $FAILED -ne 0 ]; then
    err "One or more imports failed — the stack cannot start."
    exit 1
fi

# ── Verify CUDA is visible to torch (fatal on inference nodes) ────────────────

TORCH_CUDA=$("$PYTHON" -c "import torch; print(torch.cuda.is_available())" 2>/dev/null)
if [ "$TORCH_CUDA" = "True" ]; then
    TORCH_CUDA_VER=$("$PYTHON" -c "import torch; print(torch.version.cuda)" 2>/dev/null)
    ok "torch CUDA available (compiled against CUDA $TORCH_CUDA_VER)"
else
    echo ""
    err "torch.cuda.is_available() = False"
    err "torch installed as CPU-only — vLLM cannot use the GPU in this state."
    echo ""
    if [ "$ARCH" = "aarch64" ]; then
        echo "  aarch64 install tip:"
        echo "    The cu130 wheel index was used. If this failed, try manually:"
        echo "    $PIP install torch --index-url https://download.pytorch.org/whl/cu130"
        echo "    $PIP install vllm --extra-index-url https://wheels.vllm.ai/nightly/cu130/"
        echo ""
        echo "  For DGX Spark (SM121): vLLM ≥0.10.2 supports aarch64 via SM120 forward-compat."
        echo "  If wheels are unavailable, use NVIDIA's container image:"
        echo "    nvcr.io/nvidia/cuda:latest"
    else
        echo "  Verify the CUDA wheel was installed:"
        echo "    $PYTHON -c \"import torch; print(torch.__version__, torch.version.cuda)\""
        echo "  If it shows '+cpu', re-run with the correct index for your CUDA version:"
        echo "    CUDA 12.x: https://download.pytorch.org/whl/cu124"
        echo "    CUDA 13.x: https://download.pytorch.org/whl/cu128"
    fi
    echo ""
    exit 1
fi

echo ""
echo -e "${GREEN}=== Setup complete ===${NC}"
echo ""

export VENV_DIR
