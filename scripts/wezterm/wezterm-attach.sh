#!/usr/bin/env bash

set -euo pipefail

# Source common utilities
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/wezterm-common.sh"

# === ARGUMENT PARSING ===
WORKSPACE=""
WINDOW_ID=""
NEW_WINDOW=false
INTERACTIVE=true

while [[ $# -gt 0 ]]; do
  case $1 in
    --workspace) WORKSPACE="$2"; shift 2 ;;
    --window-id) WINDOW_ID="$2"; shift 2 ;;
    --new-window) NEW_WINDOW=true; shift ;;
    --non-interactive) INTERACTIVE=false; shift ;;
    *) echo "ERROR: Unknown option: $1" >&2; exit 2 ;;
  esac
done

# === PRE-FLIGHT CHECKS ===
validate_wezterm_installed || exit 1
validate_jq_installed || exit 1

# === ENSURE MUX SERVER IS RUNNING ===
CLI_FLAGS="--prefer-mux"

if ! get_mux_status; then
  log_info "Mux server not running, starting..."
  wezterm start --always-new-process &
  
  # Wait for mux server (5 second timeout)
  MAX_WAIT=50
  WAIT_COUNT=0
  while ! wezterm cli $CLI_FLAGS list &>/dev/null; do
    sleep 0.1
    WAIT_COUNT=$((WAIT_COUNT + 1))
    if [[ $WAIT_COUNT -ge $MAX_WAIT ]]; then
      log_error "Failed to start mux server within 5 seconds"
      exit 4
    fi
  done
  log_info "Mux server started"
fi

# === GET AVAILABLE WORKSPACES ===
SESSIONS=$(get_session_list "$CLI_FLAGS")

if [[ -z "$SESSIONS" ]] || [[ "$SESSIONS" == "[]" ]]; then
  log_info "No existing sessions found"
  
  if [[ -n "$WORKSPACE" ]]; then
    log_info "Creating new workspace '$WORKSPACE'..."
    wezterm cli $CLI_FLAGS spawn --new-window --workspace "$WORKSPACE"
    echo "Created and attached to workspace '$WORKSPACE'"
    exit 0
  else
    log_info "Creating new workspace 'default'..."
    wezterm cli $CLI_FLAGS spawn --new-window
    echo "Created and attached to default workspace"
    exit 0
  fi
fi

# === INTERACTIVE WORKSPACE PICKER ===
if [[ -z "$WORKSPACE" ]] && [[ "$INTERACTIVE" == true ]]; then
  log_info "Available workspaces:"
  
  WORKSPACES=$(get_workspaces "$CLI_FLAGS")
  
  # Build workspace list with details
  WORKSPACE_ARRAY=()
  WORKSPACE_DETAILS=()
  INDEX=1
  
  while IFS= read -r ws; do
    WS_SESSIONS=$(get_workspace_sessions "$ws" "$CLI_FLAGS")
    TAB_COUNT=$(echo "$WS_SESSIONS" | jq '[.[].tab_id] | unique | length')
    PANE_COUNT=$(echo "$WS_SESSIONS" | jq 'length')
    
    WORKSPACE_ARRAY+=("$ws")
    WORKSPACE_DETAILS+=("$ws ($TAB_COUNT tabs, $PANE_COUNT panes)")
    
    echo "  $INDEX) ${WORKSPACE_DETAILS[$((INDEX-1))]}"
    INDEX=$((INDEX + 1))
  done <<< "$WORKSPACES"
  
  # Add "create new" option
  echo "  $INDEX) Create new workspace"
  
  # Prompt for selection
  echo ""
  read -p "Select workspace (1-$INDEX): " -r SELECTION
  
  if [[ "$SELECTION" -eq "$INDEX" ]]; then
    # Create new workspace
    read -p "Enter new workspace name: " -r WORKSPACE
    log_info "Creating new workspace '$WORKSPACE'..."
    wezterm cli $CLI_FLAGS spawn --new-window --workspace "$WORKSPACE"
    echo "Created and attached to workspace '$WORKSPACE'"
    exit 0
  elif [[ "$SELECTION" -ge 1 ]] && [[ "$SELECTION" -lt "$INDEX" ]]; then
    WORKSPACE="${WORKSPACE_ARRAY[$((SELECTION-1))]}"
  else
    log_error "Invalid selection"
    exit 2
  fi
fi

# === ATTACH TO WORKSPACE ===
if [[ -n "$WORKSPACE" ]]; then
  # Check if workspace exists
  if workspace_exists "$WORKSPACE" "$CLI_FLAGS"; then
    if [[ "$NEW_WINDOW" == true ]]; then
      # Create new window in workspace
      log_info "Creating new window in workspace '$WORKSPACE'..."
      wezterm cli $CLI_FLAGS spawn --new-window --workspace "$WORKSPACE"
      echo "Created new window in workspace '$WORKSPACE'"
    else
      # Get existing window ID and attach/focus
      WINDOW_ID=$(get_workspace_window_id "$WORKSPACE" "$CLI_FLAGS")
      log_info "Attaching to workspace '$WORKSPACE' (window $WINDOW_ID)..."
      
      # Focus the workspace by spawning a connection
      wezterm connect "$WORKSPACE" 2>/dev/null || {
        # If connect doesn't work, just spawn a new window
        wezterm cli $CLI_FLAGS spawn --new-window --workspace "$WORKSPACE"
      }
      
      echo "Attached to workspace '$WORKSPACE'"
    fi
  else
    log_info "Workspace '$WORKSPACE' doesn't exist, creating..."
    wezterm cli $CLI_FLAGS spawn --new-window --workspace "$WORKSPACE"
    echo "Created and attached to workspace '$WORKSPACE'"
  fi
  exit 0
fi

# === ATTACH TO SPECIFIC WINDOW ===
if [[ -n "$WINDOW_ID" ]]; then
  # Verify window exists
  WINDOW_SESSIONS=$(get_window_sessions "$WINDOW_ID" "$CLI_FLAGS")
  
  if [[ -z "$WINDOW_SESSIONS" ]] || [[ "$WINDOW_SESSIONS" == "[]" ]]; then
    log_error "Window $WINDOW_ID not found"
    exit 3
  fi
  
  WORKSPACE=$(echo "$WINDOW_SESSIONS" | jq -r '.[0].workspace')
  log_info "Attaching to window $WINDOW_ID (workspace '$WORKSPACE')..."
  
  # Focus the first pane in the window
  PANE_ID=$(echo "$WINDOW_SESSIONS" | jq -r '.[0].pane_id')
  wezterm cli $CLI_FLAGS activate-pane --pane-id "$PANE_ID"
  
  echo "Attached to window $WINDOW_ID in workspace '$WORKSPACE'"
  exit 0
fi

# === FALLBACK ===
log_error "No workspace or window specified"
exit 2
