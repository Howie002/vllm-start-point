#!/bin/bash
# =============================================================================
#  setup.sh — Create venv (if needed) and install / update all dependencies
#
#  Safe to run repeatedly — skips work that is already done.
#  Called automatically by start_inference_stack.sh on every launch.
#
#  The venv lives at ~/.vllm-venv (no spaces in path) because nvcc/flashinfer
#  JIT compilation breaks when include paths contain spaces.
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$HOME/.vllm-venv"          # Space-free path — required for nvcc JIT
REQUIREMENTS="$SCRIPT_DIR/requirements.txt"

# ── Helpers ───────────────────────────────────────────────────────────────────

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

ok()   { echo -e "  ${GREEN}✓${NC}  $1"; }
warn() { echo -e "  ${YELLOW}!${NC}  $1"; }
err()  { echo -e "  ${RED}✗${NC}  $1"; }
step() { echo -e "\n${YELLOW}▶${NC}  $1"; }

# ── System tools + CUDA toolkit ───────────────────────────────────────────────

step "Checking system dependencies..."

MISSING_TOOLS=()
for tool in curl wget lsof; do
    if ! command -v $tool &>/dev/null; then
        MISSING_TOOLS+=($tool)
    fi
done

if [ ${#MISSING_TOOLS[@]} -gt 0 ]; then
    echo "  Installing missing tools: ${MISSING_TOOLS[*]}"
    if sudo -n apt-get install -y -qq "${MISSING_TOOLS[@]}" 2>/dev/null; then
        ok "Installed: ${MISSING_TOOLS[*]}"
    else
        warn "Could not auto-install ${MISSING_TOOLS[*]} (sudo requires password)"
        warn "Run manually:  sudo apt-get install -y ${MISSING_TOOLS[*]}"
    fi
fi
ok "System tools checked"

# vLLM 0.19.0 requires nvcc (CUDA toolkit) at runtime for GPU memory profiling.
# Install cuda-toolkit-12-8 to match the torch+cu128 wheels in the venv.
# Add CUDA to PATH if installed but not in PATH
if [ -d "/usr/local/cuda/bin" ] && [[ ":$PATH:" != *":/usr/local/cuda/bin:"* ]]; then
    export PATH="/usr/local/cuda/bin:$PATH"
fi
# Also check versioned path
for CUDA_PATH in /usr/local/cuda-12.8/bin /usr/local/cuda-12/bin; do
    if [ -d "$CUDA_PATH" ] && [[ ":$PATH:" != *":$CUDA_PATH:"* ]]; then
        export PATH="$CUDA_PATH:$PATH"
    fi
done

if ! command -v nvcc &>/dev/null; then
    warn "nvcc not found — CUDA toolkit is required for vLLM to run."
    echo ""
    echo "  ┌─────────────────────────────────────────────────────────────┐"
    echo "  │  Run this ONCE in your terminal, then re-run start.bat:     │"
    echo "  │                                                             │"
    echo "  │  sudo apt-get install -y cuda-toolkit-12-8                  │"
    echo "  │                                                             │"
    echo "  │  If the package is not found, add the NVIDIA repo first:    │"
    echo "  │  wget https://developer.download.nvidia.com/compute/cuda/   │"
    echo "  │       repos/ubuntu2404/x86_64/cuda-keyring_1.1-1_all.deb   │"
    echo "  │  sudo dpkg -i cuda-keyring_1.1-1_all.deb                   │"
    echo "  │  sudo apt-get update && sudo apt-get install cuda-toolkit-12-8 │"
    echo "  └─────────────────────────────────────────────────────────────┘"
    echo ""
    # Try passwordless sudo — works if user has NOPASSWD in sudoers
    if sudo -n apt-get install -y -qq cuda-toolkit-12-8 2>/dev/null; then
        ok "CUDA toolkit 12.8 installed automatically"
    else
        err "Cannot install cuda-toolkit-12-8 without an interactive sudo password."
        err "See instructions above, then re-run start.bat."
        exit 1
    fi
else
    NVCC_VER=$(nvcc --version 2>/dev/null | grep -oP "release \K[\d.]+" | head -1)
    ok "nvcc found (CUDA $NVCC_VER)"
fi

# ── Python check ──────────────────────────────────────────────────────────────

step "Checking Python environment..."

if ! command -v python3 &>/dev/null; then
    err "python3 not found. Run: sudo apt install python3 python3-venv"
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

# Check python3-venv is available (needed to create the venv)
if ! python3 -m venv --help &>/dev/null; then
    err "python3-venv not found. Run: sudo apt install python3-venv python3-full"
    exit 1
fi

# ── Create venv if it doesn't exist ──────────────────────────────────────────

step "Checking virtual environment..."

if [ ! -d "$VENV_DIR" ]; then
    echo "  Creating virtual environment at .venv/ ..."
    python3 -m venv "$VENV_DIR"
    ok "Virtual environment created"
else
    ok "Virtual environment exists (.venv/)"
fi

# All pip/python commands from here use the venv
PIP="$VENV_DIR/bin/pip"
PYTHON="$VENV_DIR/bin/python"

# Upgrade pip inside the venv silently
"$PIP" install --upgrade pip --quiet

# ── GPU / CUDA check ──────────────────────────────────────────────────────────

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
nvidia-smi --query-gpu=index,name,memory.total --format=csv,noheader 2>/dev/null | \
    while IFS=, read -r idx name mem; do
        echo "       GPU $idx:$name ($mem)"
    done

CUDA_VERSION=$(nvidia-smi | grep -oP "CUDA Version: \K[\d.]+" | head -1)
ok "Driver CUDA version: $CUDA_VERSION"

# ── Install / update packages ─────────────────────────────────────────────────

step "Installing / updating packages from requirements.txt..."

if [ ! -f "$REQUIREMENTS" ]; then
    err "requirements.txt not found at $REQUIREMENTS"
    exit 1
fi

# vLLM pre-built CUDA wheels live on PyTorch's index
VLLM_INDEX="https://download.pytorch.org/whl/cu124"

"$PIP" install \
    --extra-index-url "$VLLM_INDEX" \
    -r "$REQUIREMENTS" \
    2>&1 | while IFS= read -r line; do
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

# Capture the real exit code (the pipe above masks it)
"$PIP" install \
    --extra-index-url "$VLLM_INDEX" \
    -r "$REQUIREMENTS" \
    --quiet 2>&1
PIP_EXIT=$?

if [ $PIP_EXIT -ne 0 ]; then
    err "pip install failed (exit $PIP_EXIT). Check output above."
    exit 1
fi

# ── Verify critical imports ───────────────────────────────────────────────────

step "Verifying installs..."

check_import() {
    local pkg=$1
    local import_name=${2:-$1}
    if "$PYTHON" -c "import $import_name" 2>/dev/null; then
        VERSION=$("$PYTHON" -c "import $import_name; print(getattr($import_name, '__version__', 'unknown'))" 2>/dev/null)
        ok "$pkg $VERSION"
    else
        err "$pkg import failed — check pip output above"
        return 1
    fi
}

FAILED=0
check_import "vllm"              || FAILED=1
check_import "litellm"           || FAILED=1
check_import "apscheduler"       || FAILED=1
check_import "huggingface_hub"   || FAILED=1
check_import "torch"             || FAILED=1

if [ $FAILED -ne 0 ]; then
    echo ""
    err "One or more imports failed. The stack cannot start."
    exit 1
fi

# ── Verify CUDA is visible to torch ──────────────────────────────────────────

TORCH_CUDA=$("$PYTHON" -c "import torch; print(torch.cuda.is_available())" 2>/dev/null)
if [ "$TORCH_CUDA" = "True" ]; then
    TORCH_CUDA_VER=$("$PYTHON" -c "import torch; print(torch.version.cuda)" 2>/dev/null)
    ok "torch CUDA available (compiled against CUDA $TORCH_CUDA_VER)"
else
    warn "torch.cuda.is_available() = False"
    warn "vLLM requires CUDA — verify the cu124 wheel installed correctly."
fi

echo ""
echo -e "${GREEN}=== Setup complete ===${NC}"
echo ""

# Export the venv path so start_inference_stack.sh can use it
export VENV_DIR
