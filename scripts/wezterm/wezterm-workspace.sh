#!/usr/bin/env bash

set -euo pipefail

# Source common utilities
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/wezterm-common.sh"

# === ARGUMENT PARSING ===
ACTION=""
NAME=""
NEW_NAME=""
USE_MUX=true
DOMAIN_NAME=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --action) ACTION="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --new-name) NEW_NAME="$2"; shift 2 ;;
    --use-mux) USE_MUX=true; shift ;;
    --domain-name) DOMAIN_NAME="$2"; shift 2 ;;
    *) echo "ERROR: Unknown option: $1" >&2; exit 2 ;;
  esac
done

# === VALIDATION ===
validate_wezterm_installed || exit 1
validate_jq_installed || exit 1

if [[ -z "$ACTION" ]]; then
  log_error "--action is required (list, create, delete, rename, switch, info)"
  exit 2
fi

# === SETUP (workspaces require mux) ===
CLI_FLAGS=""
if [[ "$USE_MUX" == true ]]; then
  if [[ -z "$DOMAIN_NAME" ]] && is_windows; then
    DOMAIN_NAME="local"
  fi
  CLI_FLAGS="--prefer-mux"
  
  # Ensure mux server is running
  if ! get_mux_status; then
    log_info "Mux server not running, starting..."
    wezterm start --always-new-process &
    
    MAX_WAIT=50
    WAIT_COUNT=0
    while ! wezterm cli $CLI_FLAGS list &>/dev/null; do
      sleep 0.1
      WAIT_COUNT=$((WAIT_COUNT + 1))
      if [[ $WAIT_COUNT -ge $MAX_WAIT ]]; then
        log_error "Failed to start mux server"
        exit 4
      fi
    done
    log_info "Mux server started"
  fi
fi

DOMAIN_ARGS=()
if [[ -n "$DOMAIN_NAME" ]]; then
  DOMAIN_ARGS=(--domain-name "$DOMAIN_NAME")
fi

# === ACTIONS ===

action_list() {
  SESSIONS=$(get_session_list "$CLI_FLAGS")
  
  if [[ -z "$SESSIONS" ]] || [[ "$SESSIONS" == "[]" ]]; then
    echo "No active workspaces found"
    exit 0
  fi
  
  echo "Available workspaces:"
  echo ""
  
  WORKSPACES=$(get_workspaces "$CLI_FLAGS")
  
  while IFS= read -r ws; do
    WS_SESSIONS=$(get_workspace_sessions "$ws" "$CLI_FLAGS")
    WINDOW_COUNT=$(echo "$WS_SESSIONS" | jq '[.[].window_id] | unique | length')
    TAB_COUNT=$(echo "$WS_SESSIONS" | jq '[.[].tab_id] | unique | length')
    PANE_COUNT=$(echo "$WS_SESSIONS" | jq 'length')
    
    # Check if any pane is active
    IS_ACTIVE=$(echo "$WS_SESSIONS" | jq 'any(.is_active == true)')
    ACTIVE_MARKER=""
    if [[ "$IS_ACTIVE" == "true" ]]; then
      ACTIVE_MARKER=" *active*"
    fi
    
    echo "  $ws ($WINDOW_COUNT windows, $TAB_COUNT tabs, $PANE_COUNT panes)$ACTIVE_MARKER"
  done <<< "$WORKSPACES"
}

action_info() {
  if [[ -z "$NAME" ]]; then
    log_error "--name required for info action"
    exit 2
  fi
  
  if ! workspace_exists "$NAME" "$CLI_FLAGS"; then
    log_error "Workspace '$NAME' not found"
    exit 3
  fi
  
  WS_SESSIONS=$(get_workspace_sessions "$NAME" "$CLI_FLAGS")
  WINDOW_COUNT=$(echo "$WS_SESSIONS" | jq '[.[].window_id] | unique | length')
  TAB_COUNT=$(echo "$WS_SESSIONS" | jq '[.[].tab_id] | unique | length')
  PANE_COUNT=$(echo "$WS_SESSIONS" | jq 'length')
  
  echo "Workspace: $NAME"
  echo "Windows: $WINDOW_COUNT"
  echo "Tabs: $TAB_COUNT"
  
  # List tabs with pane counts
  echo "$WS_SESSIONS" | jq -r '
    group_by(.tab_id) | 
    map({
      tab_id: .[0].tab_id,
      title: .[0].tab_title,
      panes: length
    }) |
    .[] |
    "  - \(.title) (\(.panes) panes)"
  '
  
  echo "Total Panes: $PANE_COUNT"
  
  # Show active pane
  ACTIVE_PANE=$(echo "$WS_SESSIONS" | jq -r '
    .[] | select(.is_active == true) |
    "Active: Tab \"\(.tab_title)\", Pane \(.pane_id)"
  ')
  
  if [[ -n "$ACTIVE_PANE" ]]; then
    echo "$ACTIVE_PANE"
  fi
}

action_create() {
  if [[ -z "$NAME" ]]; then
    log_error "--name required for create action"
    exit 2
  fi
  
  if workspace_exists "$NAME" "$CLI_FLAGS"; then
    log_warn "Workspace '$NAME' already exists"
    exit 0
  fi
  
  log_info "Creating workspace '$NAME'..."
  wezterm cli $CLI_FLAGS spawn --new-window ${DOMAIN_ARGS[@]+"${DOMAIN_ARGS[@]}"} --workspace "$NAME"
  
  echo "Created workspace '$NAME'"
}

action_switch() {
  if [[ -z "$NAME" ]]; then
    log_error "--name required for switch action"
    exit 2
  fi
  
  if ! workspace_exists "$NAME" "$CLI_FLAGS"; then
    log_warn "Workspace '$NAME' doesn't exist, creating..."
    wezterm cli $CLI_FLAGS spawn --new-window ${DOMAIN_ARGS[@]+"${DOMAIN_ARGS[@]}"} --workspace "$NAME"
    echo "Created and switched to workspace '$NAME'"
  else
    # Get first pane in workspace and activate it
    PANE_ID=$(get_workspace_sessions "$NAME" "$CLI_FLAGS" | jq -r '.[0].pane_id')
    wezterm cli $CLI_FLAGS activate-pane --pane-id "$PANE_ID"
    echo "Switched to workspace '$NAME'"
  fi
}

action_rename() {
  if [[ -z "$NAME" ]]; then
    log_error "--name required for rename action"
    exit 2
  fi
  
  if [[ -z "$NEW_NAME" ]]; then
    log_error "--new-name required for rename action"
    exit 2
  fi
  
  if ! workspace_exists "$NAME" "$CLI_FLAGS"; then
    log_error "Workspace '$NAME' not found"
    exit 3
  fi
  
  log_info "Renaming workspace '$NAME' to '$NEW_NAME'..."
  
  # Get first pane in workspace
  PANE_ID=$(get_workspace_sessions "$NAME" "$CLI_FLAGS" | jq -r '.[0].pane_id')
  
  # Rename workspace
  wezterm cli $CLI_FLAGS rename-workspace --pane-id "$PANE_ID" "$NEW_NAME"
  
  echo "Renamed workspace '$NAME' to '$NEW_NAME'"
}

action_delete() {
  if [[ -z "$NAME" ]]; then
    log_error "--name required for delete action"
    exit 2
  fi
  
  if ! workspace_exists "$NAME" "$CLI_FLAGS"; then
    log_error "Workspace '$NAME' not found"
    exit 3
  fi
  
  WS_SESSIONS=$(get_workspace_sessions "$NAME" "$CLI_FLAGS")
  PANE_COUNT=$(echo "$WS_SESSIONS" | jq 'length')
  
  log_warn "This will kill all $PANE_COUNT panes in workspace '$NAME'"
  
  if safe_confirm "Continue? (y/n):"; then
    # Kill all panes in workspace
    PANE_IDS=$(echo "$WS_SESSIONS" | jq -r '.[].pane_id')
    for pane_id in $PANE_IDS; do
      wezterm cli $CLI_FLAGS kill-pane --pane-id "$pane_id" 2>/dev/null || true
    done
    
    echo "Deleted workspace '$NAME' ($PANE_COUNT panes killed)"
  else
    log_info "Aborted"
  fi
}

# === EXECUTE ACTION ===
case "$ACTION" in
  list) action_list ;;
  info) action_info ;;
  create) action_create ;;
  switch) action_switch ;;
  rename) action_rename ;;
  delete) action_delete ;;
  *)
    log_error "Unknown action: $ACTION"
    echo "Valid actions: list, info, create, switch, rename, delete" >&2
    exit 2
    ;;
esac
