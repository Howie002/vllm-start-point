#!/bin/bash
# node.sh — vLLM Stack Node Manager
# Usage:
#   ./node.sh            — interactive menu (first run = full setup)
#   ./node.sh start      — start services for this node's role
#   ./node.sh stop       — stop all local services
#   ./node.sh setup      — (re)configure + install
#   ./node.sh add-node   — register a new child node
#   ./node.sh status     — show what's running

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/node_config.json"
VENV_DIR="$HOME/.vllm-venv"
mkdir -p "$SCRIPT_DIR/logs"
LOG_FILE="$SCRIPT_DIR/logs/node.log"

# ── Logging: terminal gets colour; log file gets timestamped plain text ───────
_log_file_writer() {
    while IFS= read -r line; do
        # Strip ANSI colour codes before writing to file
        printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" \
            "$(printf '%s' "$line" | sed 's/\x1b\[[0-9;]*[mK]//g')" >> "$LOG_FILE"
    done
}
exec > >(tee >(_log_file_writer)) 2>&1
echo "" >> "$LOG_FILE"
echo "════════════════════════════════════════" >> "$LOG_FILE"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] node.sh ${*:-menu}" >> "$LOG_FILE"

# ── Keep terminal open on unexpected exit ─────────────────────────────────────
_CLEAN_EXIT=false
trap '
  if [ "$_CLEAN_EXIT" != "true" ]; then
    echo ""
    echo "────────────────────────────────────────────"
    echo "  node.sh exited unexpectedly (line $LINENO)"
    echo "  Full log: '"$LOG_FILE"'"
    echo "────────────────────────────────────────────"
    read -rp "  Press Enter to close... " _
  fi
' EXIT

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${CYAN}▸ $*${RESET}"; }
success() { echo -e "${GREEN}✓ $*${RESET}"; }
warn()    { echo -e "${YELLOW}⚠  $*${RESET}"; }
bail()    { echo -e "${RED}✗ $*${RESET}"; echo "Log: $LOG_FILE"; read -rp "Press Enter to close... " _; _CLEAN_EXIT=true; exit 1; }
header()  { echo -e "\n${BOLD}── $* ─────────────────────────────────────────${RESET}"; }

# ── Python config helpers (env-var based — no shell quoting issues) ───────────

cfg_get() {
    # cfg_get KEY DEFAULT
    python3 -c "
import json, sys
try:
    d = json.load(open('$CONFIG_FILE'))
    print(d$1)
except Exception:
    print(sys.argv[1] if len(sys.argv) > 1 else '')
" "${2:-}" 2>/dev/null || echo "${2:-}"
}

cfg_nodes() {
    python3 - "$CONFIG_FILE" <<'PY' 2>/dev/null
import json, sys
nodes = json.load(open(sys.argv[1])).get("nodes", [])
for n in nodes:
    print("{}|{}|{}".format(n["name"], n["ip"], n.get("agent_port", 5000)))
PY
}

write_config() {
    # All values passed as env vars — avoids quoting/injection issues
    python3 - "$CONFIG_FILE" <<'PY'
import json, os, sys
cfg = {
    "role":    os.environ["CFG_ROLE"],
    "this_ip": os.environ["CFG_THIS_IP"],
    "master": {
        "ip":             os.environ["CFG_MASTER_IP"],
        "agent_port":     int(os.environ.get("CFG_MASTER_AGENT_PORT", "5000")),
        "dashboard_port": int(os.environ["CFG_DASH_PORT"])
    },
    "agent_port": int(os.environ["CFG_AGENT_PORT"]),
    "nodes":      json.loads(os.environ.get("CFG_NODES", "[]"))
}
json.dump(cfg, open(sys.argv[1], "w"), indent=2)
print(json.dumps(cfg, indent=2))
PY
}

append_node_to_config() {
    NODE_NAME="$1" NODE_IP="$2" NODE_PORT="$3" \
    python3 - "$CONFIG_FILE" <<'PY'
import json, os, sys
cfg  = json.load(open(sys.argv[1]))
name = os.environ["NODE_NAME"]
ip   = os.environ["NODE_IP"]
port = int(os.environ["NODE_PORT"])
nodes = [n for n in cfg.get("nodes", []) if n["ip"] != ip]
nodes.append({"name": name, "ip": ip, "agent_port": port})
cfg["nodes"] = nodes
json.dump(cfg, open(sys.argv[1], "w"), indent=2)
print("Saved.")
PY
}

# ── Detect LAN IP ─────────────────────────────────────────────────────────────
detect_ip() {
    python3 -c "
import socket
try:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.connect(('8.8.8.8', 80))
    print(s.getsockname()[0])
    s.close()
except Exception:
    print('127.0.0.1')
"
}

# ── Install: Node.js + dashboard build ───────────────────────────────────────
install_master_deps() {
    header "Installing master dependencies"

    if ! command -v node &>/dev/null; then
        info "Node.js not found — installing v20 via NodeSource..."
        if ! command -v curl &>/dev/null; then
            sudo apt-get install -y curl || bail "Could not install curl. Install it manually and re-run."
        fi
        curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - \
            || bail "NodeSource setup script failed. Install Node.js 20+ manually."
        sudo apt-get install -y nodejs \
            || bail "apt-get install nodejs failed."
    fi

    local ver
    ver=$(node -e "process.stdout.write(process.versions.node)" 2>/dev/null || echo "unknown")
    success "Node.js $ver"

    info "Installing npm packages..."
    cd "$SCRIPT_DIR/dashboard"
    npm install --loglevel=error \
        || bail "npm install failed. Check $LOG_FILE for details."

    info "Building dashboard..."
    npm run build \
        || bail "npm run build failed. Check $LOG_FILE for details."

    cd "$SCRIPT_DIR"
    success "Dashboard ready"
}

# ── Install: Python venv + vLLM + agent deps ─────────────────────────────────
install_child_deps() {
    header "Installing child (inference) dependencies"

    # CUDA toolkit
    if ! command -v nvcc &>/dev/null; then
        warn "nvcc not found — attempting to install cuda-toolkit-12-8..."
        if command -v apt-get &>/dev/null; then
            if ! apt-cache show cuda-toolkit-12-8 &>/dev/null 2>&1; then
                info "Adding NVIDIA package repository..."
                wget -q https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2404/x86_64/cuda-keyring_1.1-1_all.deb \
                    || bail "Could not download NVIDIA keyring. Check internet connection."
                sudo dpkg -i cuda-keyring_1.1-1_all.deb
                sudo apt-get update -qq
                rm -f cuda-keyring_1.1-1_all.deb
            fi
            sudo apt-get install -y cuda-toolkit-12-8 \
                || bail "cuda-toolkit-12-8 install failed. See: https://developer.nvidia.com/cuda-downloads"
        else
            warn "Cannot auto-install CUDA toolkit. Install cuda-toolkit-12-8 manually then re-run."
        fi
    else
        local cuda_ver
        cuda_ver=$(nvcc --version 2>/dev/null | grep -oP 'release \K[0-9.]+' || echo "found")
        success "CUDA toolkit $cuda_ver"
    fi

    # vLLM venv (setup.sh is idempotent)
    info "Running vLLM environment setup..."
    bash "$SCRIPT_DIR/setup.sh" \
        || bail "setup.sh failed — check $LOG_FILE"

    # Agent Python deps
    info "Installing agent Python deps (fastapi uvicorn psutil)..."
    "$VENV_DIR/bin/pip" install --quiet fastapi uvicorn psutil \
        || bail "pip install failed."

    success "Child dependencies ready"
}

# ── Setup (configure + install) ───────────────────────────────────────────────
do_setup() {
    # ── Non-interactive mode: all values from env vars ────────────────────────
    # Used by add-node SSH deployment. Set VLLM_NONINTERACTIVE=1 to enable.
    # Env vars: VLLM_ROLE, VLLM_THIS_IP, VLLM_MASTER_IP, VLLM_AGENT_PORT
    local _noninteractive="${VLLM_NONINTERACTIVE:-}"

    if [ -z "$_noninteractive" ]; then
        echo -e "\n${BOLD}╔═══════════════════════════════════════╗${RESET}"
        echo -e "${BOLD}║   vLLM Stack — Node Setup              ║${RESET}"
        echo -e "${BOLD}╚═══════════════════════════════════════╝${RESET}\n"

        if [ -f "$CONFIG_FILE" ]; then
            local existing_role
            existing_role=$(cfg_get "['role']" "?")
            warn "Existing config found (role: $existing_role)."
            read -rp "Overwrite and reconfigure? [y/N]: " yn
            [[ "${yn,,}" == "y" ]] || { info "Keeping existing config."; _CLEAN_EXIT=true; exit 0; }
        fi
    fi

    # ── This machine's IP ─────────────────────────────────────────────────────
    local detected_ip
    detected_ip=$(detect_ip)
    local this_ip
    if [ -n "$_noninteractive" ] && [ -n "${VLLM_THIS_IP:-}" ]; then
        this_ip="$VLLM_THIS_IP"
        info "This IP: $this_ip"
    else
        read -rp "This machine's IP [$detected_ip]: " this_ip
        this_ip="${this_ip:-$detected_ip}"
    fi

    # ── Role ──────────────────────────────────────────────────────────────────
    local role
    if [ -n "$_noninteractive" ] && [ -n "${VLLM_ROLE:-}" ]; then
        role="$VLLM_ROLE"
        info "Role: $role"
    else
        echo ""
        echo "  Select this node's role:"
        echo "    1) master  — dashboard only (no local GPU inference)"
        echo "    2) child   — GPU inference node (no dashboard)"
        echo "    3) both    — dashboard + GPU inference on this machine"
        read -rp "  Role [1/2/3, default 3]: " role_num
        case "${role_num:-3}" in
            1) role="master" ;;
            2) role="child"  ;;
            3) role="both"   ;;
            *) role="both"   ;;
        esac
    fi
    success "Role: $role"

    # ── Master IP ─────────────────────────────────────────────────────────────
    local master_ip
    if [ -n "$_noninteractive" ] && [ -n "${VLLM_MASTER_IP:-}" ]; then
        master_ip="$VLLM_MASTER_IP"
        info "Master IP: $master_ip"
    elif [ "$role" = "child" ]; then
        read -rp "Master node IP: " master_ip
        master_ip="${master_ip:-$this_ip}"
    else
        master_ip="$this_ip"
    fi

    # ── Ports ─────────────────────────────────────────────────────────────────
    local agent_port
    if [ -n "$_noninteractive" ] && [ -n "${VLLM_AGENT_PORT:-}" ]; then
        agent_port="$VLLM_AGENT_PORT"
    else
        read -rp "Agent port [5000]: " agent_port
        agent_port="${agent_port:-5000}"
    fi

    local dashboard_port="3000"
    if [ "$role" != "child" ] && [ -z "$_noninteractive" ]; then
        read -rp "Dashboard port [3000]: " dashboard_port
        dashboard_port="${dashboard_port:-3000}"
    fi

    # ── Child nodes ───────────────────────────────────────────────────────────
    local nodes_json="[]"
    if [ "$role" != "child" ]; then
        echo ""
        info "Register child GPU nodes (press Enter with blank IP when done)."

        # Collect as parallel arrays — avoids JSON quoting inside bash
        local names=() ips=() ports=()

        if [ "$role" = "both" ]; then
            names+=("This Machine")
            ips+=("$this_ip")
            ports+=("$agent_port")
            success "  This machine added automatically."
        fi

        local i=1
        while true; do
            read -rp "  Child node $i IP (blank to finish): " child_ip
            [ -z "$child_ip" ] && break
            read -rp "    Name [GPU Server $i]: " child_name
            child_name="${child_name:-GPU Server $i}"
            read -rp "    Agent port [$agent_port]: " child_port
            child_port="${child_port:-$agent_port}"
            names+=("$child_name")
            ips+=("$child_ip")
            ports+=("$child_port")
            success "  Added: $child_name ($child_ip:$child_port)"
            i=$((i + 1))
        done

        # Build JSON array in Python — no quoting issues
        nodes_json=$(python3 - "${#names[@]}" <<'PY' 2>/dev/null
import json, sys, os
count = int(sys.argv[1])
names  = os.environ["NODE_NAMES"].split("\x00")  if os.environ.get("NODE_NAMES")  else []
ips    = os.environ["NODE_IPS"].split("\x00")    if os.environ.get("NODE_IPS")    else []
ports  = os.environ["NODE_PORTS"].split("\x00")  if os.environ.get("NODE_PORTS")  else []
nodes  = [{"name": names[i], "ip": ips[i], "agent_port": int(ports[i])} for i in range(count)]
print(json.dumps(nodes))
PY
) || nodes_json="[]"
        # Re-run with proper env if we have nodes
        if [ "${#names[@]}" -gt 0 ]; then
            local joined_names joined_ips joined_ports
            # Join with null byte separator (safe for any string content)
            joined_names=$(printf '%s\0' "${names[@]}")
            joined_ips=$(printf '%s\0' "${ips[@]}")
            joined_ports=$(printf '%s\0' "${ports[@]}")
            nodes_json=$(NODE_NAMES="$joined_names" NODE_IPS="$joined_ips" NODE_PORTS="$joined_ports" \
                python3 - "${#names[@]}" <<'PY'
import json, sys, os
count  = int(sys.argv[1])
names  = os.environ["NODE_NAMES"].split("\x00")[:count]
ips    = os.environ["NODE_IPS"].split("\x00")[:count]
ports  = os.environ["NODE_PORTS"].split("\x00")[:count]
nodes  = [{"name": names[i], "ip": ips[i], "agent_port": int(ports[i])} for i in range(count)]
print(json.dumps(nodes))
PY
) || nodes_json="[]"
        fi
    fi

    # ── Write config ──────────────────────────────────────────────────────────
    echo ""
    info "Writing $CONFIG_FILE..."
    CFG_ROLE="$role" \
    CFG_THIS_IP="$this_ip" \
    CFG_MASTER_IP="$master_ip" \
    CFG_MASTER_AGENT_PORT="${VLLM_MASTER_AGENT_PORT:-5000}" \
    CFG_DASH_PORT="$dashboard_port" \
    CFG_AGENT_PORT="$agent_port" \
    CFG_NODES="$nodes_json" \
    write_config || bail "Failed to write config file."
    success "Config saved."

    # ── Install ───────────────────────────────────────────────────────────────
    echo ""
    local do_install="Y"
    if [ -z "$_noninteractive" ]; then
        read -rp "Install dependencies now? [Y/n]: " do_install
    fi
    if [[ "${do_install:-Y}" =~ ^[Yy]$ ]] || [ -z "$do_install" ]; then
        case "$role" in
            master) install_master_deps ;;
            child)
                install_child_deps
                install_master_deps   # child also runs the dashboard (to see the full cluster)
                ;;
            both)
                install_child_deps
                install_master_deps
                ;;
        esac
    fi

    echo ""
    success "Setup complete — starting services now..."
    echo ""
    do_start
}

# ── Add node ──────────────────────────────────────────────────────────────────
do_add_node() {
    [ ! -f "$CONFIG_FILE" ] && bail "No config found. Run './node.sh setup' first."
    local role
    role=$(cfg_get "['role']" "?")
    [ "$role" = "child" ] && bail "This is a child node. Run add-node from the master."

    header "Add Child Node"

    read -rp "New node IP: " new_ip
    [ -z "$new_ip" ] && bail "IP cannot be blank."
    read -rp "Node name [GPU Server]: " new_name
    new_name="${new_name:-GPU Server}"
    local default_port master_ip this_ip
    default_port=$(cfg_get ".get('agent_port', 5000)" "5000")
    master_ip=$(cfg_get "['master']['ip']" "$(detect_ip)")
    this_ip=$(cfg_get ".get('this_ip', '$(detect_ip)')" "$(detect_ip)")
    read -rp "Agent port [$default_port]: " new_port
    new_port="${new_port:-$default_port}"

    # Register in master config
    append_node_to_config "$new_name" "$new_ip" "$new_port" \
        || bail "Failed to update config."
    success "Registered '$new_name' ($new_ip:$new_port) in master config."
    info "Dashboard will show this node once its agent is running."

    # ── Check if already reachable ────────────────────────────────────────────
    echo ""
    info "Checking if agent is already running on $new_ip:$new_port..."
    if curl -sf --connect-timeout 4 "http://$new_ip:$new_port/health" &>/dev/null; then
        success "Agent at $new_ip:$new_port is already up — nothing more to do."
        read -rp "Press Enter to close..." _
        _CLEAN_EXIT=true
        return
    fi
    warn "Agent not reachable yet. The child node needs to be set up."

    # ── Generate the one-liner for the child machine ──────────────────────────
    local repo_dir
    repo_dir="$(basename "$SCRIPT_DIR")"
    # Try to get git remote URL for clone instructions
    local git_remote=""
    git_remote=$(git -C "$SCRIPT_DIR" remote get-url origin 2>/dev/null || true)

    echo ""
    echo -e "${BOLD}  ── Option A: Run manually on the child machine ─────────────────${RESET}"
    echo ""
    if [ -n "$git_remote" ]; then
        echo "    git clone $git_remote"
        echo "    cd $repo_dir"
    else
        echo "    # Copy this repo to the child machine first, then:"
        echo "    cd <repo directory>"
    fi
    echo ""
    echo -e "    ${CYAN}VLLM_NONINTERACTIVE=1 \\"
    echo -e "    VLLM_ROLE=child \\"
    echo -e "    VLLM_THIS_IP=$new_ip \\"
    echo -e "    VLLM_MASTER_IP=$master_ip \\"
    echo -e "    VLLM_AGENT_PORT=$new_port \\"
    echo -e "    ./node.sh setup${RESET}"
    echo ""

    # ── Offer SSH deployment ──────────────────────────────────────────────────
    echo -e "${BOLD}  ── Option B: Deploy via SSH (requires SSH access) ──────────────${RESET}"
    echo ""
    read -rp "  Deploy to $new_ip via SSH now? [y/N]: " do_ssh
    if [[ "${do_ssh,,}" == "y" ]]; then
        read -rp "  SSH user [$(whoami)]: " ssh_user
        ssh_user="${ssh_user:-$(whoami)}"
        read -rp "  SSH port [22]: " ssh_port
        ssh_port="${ssh_port:-22}"

        # Verify SSH works
        info "Testing SSH connection to $ssh_user@$new_ip..."
        ssh -p "$ssh_port" -o ConnectTimeout=8 -o BatchMode=yes \
            "$ssh_user@$new_ip" "echo ok" &>/dev/null \
            || bail "SSH connection failed. Ensure key-based auth is set up for $ssh_user@$new_ip."
        success "SSH connection OK."

        # Copy repo via rsync (excluding build artifacts and model cache)
        info "Copying repo to $new_ip..."
        local remote_path="/home/$ssh_user/$repo_dir"
        rsync -az --progress \
            --exclude='.next' \
            --exclude='node_modules' \
            --exclude='logs' \
            --exclude='.stack_pids' \
            --exclude='node_config.json' \
            --exclude='__pycache__' \
            -e "ssh -p $ssh_port" \
            "$SCRIPT_DIR/" \
            "$ssh_user@$new_ip:$remote_path/" \
            || bail "rsync failed."
        success "Repo copied to $new_ip:$remote_path"

        # Run setup non-interactively on the remote
        info "Running setup on $new_ip (this will take a few minutes)..."
        ssh -p "$ssh_port" -t "$ssh_user@$new_ip" \
            "cd '$remote_path' && \
             VLLM_NONINTERACTIVE=1 \
             VLLM_ROLE=child \
             VLLM_THIS_IP=$new_ip \
             VLLM_MASTER_IP=$master_ip \
             VLLM_AGENT_PORT=$new_port \
             bash ./node.sh setup" \
            || bail "Remote setup failed. Check logs on $new_ip at $remote_path/logs/node.log"

        success "Child node $new_name set up and started."

        # Verify
        sleep 3
        if curl -sf --connect-timeout 8 "http://$new_ip:$new_port/health" &>/dev/null; then
            success "Agent at $new_ip:$new_port is live!"
        else
            warn "Agent not responding yet — it may still be starting. Check dashboard in a minute."
        fi
    fi

    echo ""
    read -rp "Press Enter to close..." _
    _CLEAN_EXIT=true
}

# ── Start ─────────────────────────────────────────────────────────────────────
do_start() {
    [ ! -f "$CONFIG_FILE" ] && bail "No config found. Run './node.sh setup' first."

    local role agent_port master_ip dashboard_port this_ip
    role=$(cfg_get "['role']" "both")
    agent_port=$(cfg_get ".get('agent_port', 5000)" "5000")
    master_ip=$(cfg_get "['master']['ip']" "localhost")
    dashboard_port=$(cfg_get "['master']['dashboard_port']" "3000")
    this_ip=$(cfg_get ".get('this_ip', 'localhost')" "localhost")

    header "Starting services (role: $role)"

    if [ "$role" = "child" ] || [ "$role" = "both" ]; then
        info "Starting control agent (port $agent_port)..."
        AGENT_PORT="$agent_port" AGENT_BIND_IP="$this_ip" bash "$SCRIPT_DIR/agent/start_agent.sh" \
            || warn "Agent start reported errors — check agent/agent.log"
    fi

    info "Starting dashboard (port $dashboard_port)..."
    AGENT_URL="http://localhost:$agent_port" \
    DASHBOARD_PORT="$dashboard_port" \
    bash "$SCRIPT_DIR/dashboard/start_dashboard.sh" \
        || warn "Dashboard start reported errors — check dashboard/dashboard.log"

    echo ""
    success "Start sequence complete."
    echo -e "  Dashboard  →  ${CYAN}http://$this_ip:$dashboard_port${RESET}"
    if [ "$role" != "master" ]; then
        echo -e "  Agent      →  ${CYAN}http://$this_ip:$agent_port${RESET}"
        echo -e "  LiteLLM    →  ${CYAN}http://$this_ip:4000${RESET}"
    fi
    echo ""
    read -rp "Press Enter to close..." _
    _CLEAN_EXIT=true
}

# ── Stop ──────────────────────────────────────────────────────────────────────
do_stop() {
    header "Stopping local services"
    [ -f "$SCRIPT_DIR/dashboard/stop_dashboard.sh" ]    && bash "$SCRIPT_DIR/dashboard/stop_dashboard.sh"    || true
    [ -f "$SCRIPT_DIR/agent/stop_agent.sh" ]            && bash "$SCRIPT_DIR/agent/stop_agent.sh"            || true
    [ -f "$SCRIPT_DIR/stop_inference_stack.sh" ]        && bash "$SCRIPT_DIR/stop_inference_stack.sh"        || true
    success "Done."
    read -rp "Press Enter to close..." _
    _CLEAN_EXIT=true
}

# ── Status ────────────────────────────────────────────────────────────────────
do_status() {
    [ ! -f "$CONFIG_FILE" ] && bail "No config found. Run './node.sh setup' first."

    local role agent_port
    role=$(cfg_get "['role']" "?")
    agent_port=$(cfg_get ".get('agent_port', 5000)" "5000")

    header "Local services (role: $role)"

    if [ "$role" != "master" ]; then
        if curl -sf --connect-timeout 3 "http://localhost:$agent_port/health" &>/dev/null; then
            success "Agent      :$agent_port  UP"
        else
            warn "Agent      :$agent_port  DOWN"
        fi
    fi

    if [ "$role" != "child" ]; then
        local dp
        dp=$(cfg_get "['master']['dashboard_port']" "3000")
        if curl -sf --connect-timeout 3 "http://localhost:$dp" &>/dev/null; then
            success "Dashboard  :$dp  UP"
        else
            warn "Dashboard  :$dp  DOWN"
        fi
    fi

    if [ "$role" != "child" ]; then
        header "Child nodes"
        local any=false
        while IFS='|' read -r name ip port; do
            any=true
            if curl -sf --connect-timeout 3 "http://$ip:$port/health" &>/dev/null; then
                echo -e "  ${GREEN}✓${RESET}  $name  ($ip:$port)  UP"
            else
                echo -e "  ${RED}✗${RESET}  $name  ($ip:$port)  unreachable"
            fi
        done < <(cfg_nodes)
        [ "$any" = "false" ] && echo "  (no child nodes registered — run './node.sh add-node')"
    fi

    echo ""
    read -rp "Press Enter to close..." _
    _CLEAN_EXIT=true
}

# ── Logs ──────────────────────────────────────────────────────────────────────
do_logs() {
    echo ""
    echo -e "${BOLD}Log file:${RESET} $LOG_FILE"
    echo ""
    if [ ! -s "$LOG_FILE" ]; then
        echo "  (log is empty)"
    else
        # Show last 60 lines with line numbers
        tail -n 60 "$LOG_FILE" | nl -ba
        echo ""
        echo "  Full log: $LOG_FILE"
        echo "  Live tail: tail -f $LOG_FILE"
    fi
    echo ""
    read -rp "Press Enter to close..." _
    _CLEAN_EXIT=true
}

# ── Menu ──────────────────────────────────────────────────────────────────────
show_menu() {
    if [ ! -f "$CONFIG_FILE" ]; then
        info "No config found — starting first-time setup."
        sleep 1
        do_setup
        return
    fi

    local role
    role=$(cfg_get "['role']" "?")

    echo -e "\n${BOLD}  vLLM Node Manager${RESET}  (role: $role)\n"
    echo "    1)  start      start all local services"
    echo "    2)  stop       stop all local services"
    echo "    3)  status     check what's running"
    echo "    4)  add-node   register a new child node"
    echo "    5)  setup      reconfigure this node"
    echo "    6)  logs       view recent log output"
    echo "    q)  quit"
    echo ""
    read -rp "  Choice: " choice
    case "${choice,,}" in
        1|start)    do_start    ;;
        2|stop)     do_stop     ;;
        3|status)   do_status   ;;
        4|add-node) do_add_node ;;
        5|setup)    do_setup    ;;
        6|logs)     do_logs     ;;
        q|quit)     _CLEAN_EXIT=true; exit 0 ;;
        *)          show_menu   ;;
    esac
}

# ── Entry point ───────────────────────────────────────────────────────────────
CMD="${1:-menu}"
case "$CMD" in
    setup)    do_setup    ;;
    start)    do_start    ;;
    stop)     do_stop     ;;
    add-node) do_add_node ;;
    status)   do_status   ;;
    logs)     do_logs     ;;
    *)        show_menu   ;;
esac
