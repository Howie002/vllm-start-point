#!/bin/bash
# =============================================================================
#  setup.sh — Create venv (if needed) and install / update all dependencies
#
#  Safe to run repeatedly — skips work that is already done.
#  Called automatically by node.sh for child/both roles.
#
#  Supports:
#    x86_64  + CUDA ≤12   →  cu124 wheels (RTX, A100, H100, etc.)
#    x86_64  + CUDA 13+   →  cu128 wheels
#    aarch64 + CUDA ≤12   →  cu124 wheels (Jetson AGX Orin, etc.)
#    aarch64 + CUDA 13+   →  cu130 wheels + vllm.ai nightly (DGX Spark GB10/GB200)
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
info() { echo -e "  ${CYAN}▸${NC}  $1"; }
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

# ── Detect architecture ───────────────────────────────────────────────────────

ARCH=$(uname -m)
ok "Architecture: $ARCH"

# Map uname arch to the string NVIDIA's keyring URLs use
case "$ARCH" in
    x86_64)  KEYRING_ARCH="x86_64" ;;
    aarch64) KEYRING_ARCH="arm64"  ;;
    *)       KEYRING_ARCH="x86_64" ; warn "Unknown arch '$ARCH' — defaulting keyring to x86_64" ;;
esac

# Add all common CUDA toolkit bin paths so nvcc is findable regardless of install location
for _cpath in \
    /usr/local/cuda/bin \
    /usr/local/cuda-13/bin /usr/local/cuda-13.0/bin \
    /usr/local/cuda-12.8/bin /usr/local/cuda-12/bin \
    /usr/local/cuda-11/bin; do
    [ -d "$_cpath" ] && [[ ":$PATH:" != *":$_cpath:"* ]] && export PATH="$_cpath:$PATH"
done

# ── NVIDIA driver + GPU check ─────────────────────────────────────────────────

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

# Show GPU list — handle "Not Supported" memory on unified-memory hardware (DGX Spark)
nvidia-smi --query-gpu=index,name,memory.total --format=csv,noheader 2>/dev/null \
    | tr -d '\r' \
    | while IFS=, read -r idx name mem; do
        idx=$(echo "$idx"  | xargs)
        name=$(echo "$name" | xargs)
        mem=$(echo "$mem"  | xargs)
        case "${mem,,}" in
            "not supported"|"[n/a]"|"n/a"|"") mem="unified memory" ;;
        esac
        echo "       GPU $idx: $name ($mem)"
    done

# Driver-reported CUDA version
CUDA_DRIVER_VER=$(nvidia-smi 2>/dev/null | grep -oP "CUDA Version: \K[\d.]+" | head -1 || echo "unknown")
CUDA_MAJOR=$(echo "$CUDA_DRIVER_VER" | grep -oP "^\d+" || echo "0")
ok "Driver CUDA version: $CUDA_DRIVER_VER"

# ── Select wheel strategy based on arch + CUDA version ───────────────────────
#
#  EXTRA_INDICES   — extra-index-url flags passed to every pip install call
#  AARCH64_CU130   — true when we need the aarch64 cu130 nightly force-upgrade

step "Detecting wheel strategy..."

EXTRA_INDICES=()
AARCH64_CU130=false

if [ "$ARCH" = "aarch64" ]; then
    if [ "$CUDA_MAJOR" -ge 13 ] 2>/dev/null; then
        # DGX Spark GB10 / Grace Blackwell — CUDA 13+, aarch64
        info "aarch64 + CUDA 13 — DGX Spark / Grace Blackwell path"
        info "Using cu130 index + vllm.ai nightly (SM121 via SM120 forward-compat)"
        EXTRA_INDICES=(
            "https://download.pytorch.org/whl/cu130"
            "https://wheels.vllm.ai/nightly/cu130/"
        )
        AARCH64_CU130=true
    else
        # Jetson AGX Orin or other aarch64 + CUDA 12
        info "aarch64 + CUDA 12 — using cu124 index"
        EXTRA_INDICES=("https://download.pytorch.org/whl/cu124")
    fi
else
    # x86_64
    if [ "$CUDA_MAJOR" -ge 13 ] 2>/dev/null; then
        info "x86_64 + CUDA 13 — using cu128 index"
        EXTRA_INDICES=("https://download.pytorch.org/whl/cu128")
    else
        info "x86_64 + CUDA 12 — using cu124 index"
        EXTRA_INDICES=("https://download.pytorch.org/whl/cu124")
    fi
fi

for idx in "${EXTRA_INDICES[@]}"; do ok "Index: $idx"; done

# ── CUDA toolkit (nvcc) ───────────────────────────────────────────────────────
#
#  vLLM needs nvcc for JIT kernel compilation. The toolkit package to install
#  depends on both the driver CUDA version and the architecture.
#
#  aarch64 + CUDA 13 (DGX Spark): toolkit is pre-installed with the driver;
#  the vllm.ai cu130 wheels bundle their own CUDA runtime. Missing nvcc is a
#  warning, not a hard stop.

step "Checking CUDA toolkit (nvcc)..."

if command -v nvcc &>/dev/null; then
    NVCC_VER=$(nvcc --version 2>/dev/null | grep -oP "release \K[\d.]+" | head -1)
    ok "nvcc found (CUDA $NVCC_VER)"
elif [ "$ARCH" = "aarch64" ] && [ "$CUDA_MAJOR" -ge 13 ] 2>/dev/null; then
    warn "nvcc not in PATH on DGX Spark — vllm.ai cu130 wheels include CUDA runtime."
    warn "If vLLM JIT compilation fails later, install the toolkit manually:"
    warn "  https://developer.nvidia.com/cuda-downloads  (select Linux / aarch64 / Ubuntu)"
else
    # Determine the right toolkit package for this driver version
    if [ "$CUDA_MAJOR" -ge 13 ] 2>/dev/null; then
        TOOLKIT_PKG="cuda-toolkit-13-0"
    else
        TOOLKIT_PKG="cuda-toolkit-12-8"
    fi
    warn "nvcc not found — attempting to install $TOOLKIT_PKG..."

    if command -v apt-get &>/dev/null; then
        if ! apt-cache show "$TOOLKIT_PKG" &>/dev/null 2>&1; then
            info "Adding NVIDIA package repository (arch: $KEYRING_ARCH)..."
            KEYRING_URL="https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2404/${KEYRING_ARCH}/cuda-keyring_1.1-1_all.deb"
            wget -q "$KEYRING_URL" -O /tmp/cuda-keyring.deb \
                || { warn "Could not download NVIDIA keyring — install CUDA toolkit manually."; }
            sudo dpkg -i /tmp/cuda-keyring.deb 2>/dev/null
            sudo apt-get update -qq 2>/dev/null
            rm -f /tmp/cuda-keyring.deb
        fi
        sudo apt-get install -y "$TOOLKIT_PKG" 2>/dev/null \
            || warn "$TOOLKIT_PKG install failed — see https://developer.nvidia.com/cuda-downloads"
    else
        warn "apt-get not available — install $TOOLKIT_PKG manually."
    fi

    # Re-check after attempted install
    if command -v nvcc &>/dev/null; then
        NVCC_VER=$(nvcc --version 2>/dev/null | grep -oP "release \K[\d.]+" | head -1)
        ok "nvcc installed (CUDA $NVCC_VER)"
    else
        warn "nvcc still not found — continuing, but vLLM JIT may fail at runtime."
    fi
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

# ── Install packages ──────────────────────────────────────────────────────────

step "Installing packages from requirements.txt..."

[ ! -f "$REQUIREMENTS" ] && { err "requirements.txt not found at $REQUIREMENTS"; exit 1; }

EXTRA_FLAGS=()
for idx in "${EXTRA_INDICES[@]}"; do
    EXTRA_FLAGS+=(--extra-index-url "$idx")
done

# First pass: show output
"$PIP" install "${EXTRA_FLAGS[@]}" -r "$REQUIREMENTS" \
    2>&1 | tr -d '\r' | while IFS= read -r line; do
        if echo "$line" | grep -qiE "^error|^fatal|could not find a version|no matching distribution"; then
            err "$line"
        elif echo "$line" | grep -qiE "^successfully installed"; then
            ok "$line"
        elif echo "$line" | grep -qiE "already satisfied"; then
            :
        else
            echo "     $line"
        fi
    done

# Second pass: capture exit code (pipe above masks it)
"$PIP" install "${EXTRA_FLAGS[@]}" -r "$REQUIREMENTS" --quiet 2>&1
PIP_EXIT=$?
[ $PIP_EXIT -ne 0 ] && { err "pip install failed (exit $PIP_EXIT)"; exit 1; }

# ── aarch64 + CUDA 13: force cu130 vllm wheel ────────────────────────────────
#
#  pip prefers PyPI's stable vllm (built against CUDA 12) over the cu130 nightly
#  even when the cu130 index is listed. The stable wheel links libcudart.so.12,
#  which doesn't exist on a CUDA-13-only system. Fix: force-upgrade with --pre
#  so pip picks the cu130 nightly that links libcudart.so.13.

if [ "$AARCH64_CU130" = "true" ]; then
    step "aarch64 + CUDA 13: pinning vllm to cu130 nightly..."
    "$PIP" install --pre --upgrade vllm \
        --extra-index-url https://download.pytorch.org/whl/cu130 \
        --extra-index-url https://wheels.vllm.ai/nightly/cu130/ \
        --quiet 2>&1
    AARCH_EXIT=$?
    [ $AARCH_EXIT -ne 0 ] && { err "cu130 vllm pin failed (exit $AARCH_EXIT)"; exit 1; }
    ok "cu130 vllm wheel installed"
fi

# ── Verify imports ────────────────────────────────────────────────────────────

step "Verifying installs..."

check_import() {
    local pkg=$1 import_name=${2:-$1}
    if "$PYTHON" -c "import $import_name" 2>/dev/null; then
        local ver
        ver=$("$PYTHON" -c "
import $import_name, importlib.metadata
try:    print(importlib.metadata.version('$pkg'))
except: print(getattr($import_name, '__version__', 'unknown'))
" 2>/dev/null || echo "unknown")
        ok "$pkg $ver"
    else
        err "$pkg import failed — check pip output above"
        return 1
    fi
}

FAILED=0
check_import "vllm"            || FAILED=1
check_import "litellm"         || FAILED=1
check_import "huggingface_hub" || FAILED=1
check_import "torch"           || FAILED=1
check_import "duckdb"          || FAILED=1

[ $FAILED -ne 0 ] && { err "One or more imports failed — the stack cannot start."; exit 1; }

# vllm._C is the CUDA-linked C extension. top-level `import vllm` succeeds even
# when the wheel was built against the wrong CUDA. This catches that case early.
if ! "$PYTHON" -c "import vllm._C" 2>/tmp/vllm_c_err; then
    err "vllm._C import failed — C extension is unusable (wrong CUDA build?)."
    sed 's/^/  /' /tmp/vllm_c_err
    echo ""
    if [ "$AARCH64_CU130" = "true" ]; then
        echo "  Try manually:"
        echo "    $PIP install --pre --upgrade vllm \\"
        echo "      --extra-index-url https://download.pytorch.org/whl/cu130 \\"
        echo "      --extra-index-url https://wheels.vllm.ai/nightly/cu130/"
    else
        echo "  Ensure the correct CUDA wheel is installed for your driver version."
        echo "  Run: $PYTHON -c \"import torch; print(torch.__version__, torch.version.cuda)\""
    fi
    rm -f /tmp/vllm_c_err
    exit 1
fi
rm -f /tmp/vllm_c_err
ok "vllm._C loaded"

# ── Verify torch CUDA ─────────────────────────────────────────────────────────

TORCH_CUDA=$("$PYTHON" -c "import torch; print(torch.cuda.is_available())" 2>/dev/null)
if [ "$TORCH_CUDA" = "True" ]; then
    TORCH_CUDA_VER=$("$PYTHON" -c "import torch; print(torch.version.cuda)" 2>/dev/null)
    ok "torch CUDA available (compiled against CUDA $TORCH_CUDA_VER)"
else
    echo ""
    err "torch.cuda.is_available() = False — GPU will not be used."
    echo ""
    if [ "$ARCH" = "aarch64" ]; then
        echo "  aarch64 tip: ensure the cu130 torch wheel was installed:"
        echo "    $PIP install torch --index-url https://download.pytorch.org/whl/cu130"
    else
        echo "  Run: $PYTHON -c \"import torch; print(torch.__version__, torch.version.cuda)\""
        if [ "$CUDA_MAJOR" -ge 13 ] 2>/dev/null; then
            echo "  CUDA 13 detected — expected index: https://download.pytorch.org/whl/cu128"
        else
            echo "  CUDA 12 detected — expected index: https://download.pytorch.org/whl/cu124"
        fi
    fi
    echo ""
    exit 1
fi

echo ""
echo -e "${GREEN}=== Setup complete ===${NC}"
echo ""

export VENV_DIR
