#!/usr/bin/env bash

set -euo pipefail

# Source common utilities
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/wezterm-common.sh"

# === ARGUMENT PARSING ===
ACTION="check"
VERBOSE=false
USE_MUX=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --action) ACTION="$2"; shift 2 ;;
    --verbose) VERBOSE=true; shift ;;
    --use-mux) USE_MUX=true; shift ;;
    *) echo "ERROR: Unknown option: $1" >&2; exit 2 ;;
  esac
done

# === VALIDATION ===
validate_wezterm_installed || exit 1
validate_jq_installed || exit 1

# === SETUP CLI FLAGS ===
CLI_FLAGS=""
if [[ "$USE_MUX" == true ]]; then
  CLI_FLAGS="--prefer-mux"
fi

# === ACTIONS ===

action_check() {
  echo "WezTerm Health Check:"
  echo ""
  
  # Check WezTerm version
  WEZTERM_VERSION=$(wezterm --version 2>&1 | head -1 || echo "Unknown")
  echo "✓ WezTerm version: $WEZTERM_VERSION"
  
  # Check mux server status
  if get_mux_status; then
    echo "✓ Mux server: Running"
  else
    echo "ℹ Mux server: Not running (start with: wezterm start --always-new-process)"
  fi
  
  # Get sessions
  SESSIONS=$(get_session_list "$CLI_FLAGS")
  
  if [[ -z "$SESSIONS" ]] || [[ "$SESSIONS" == "[]" ]]; then
    echo "✓ No active sessions"
    return 0
  fi
  
  # Count sessions
  TOTAL_PANES=$(echo "$SESSIONS" | jq 'length')
  TOTAL_TABS=$(echo "$SESSIONS" | jq '[.[].tab_id] | unique | length')
  TOTAL_WINDOWS=$(echo "$SESSIONS" | jq '[.[].window_id] | unique | length')
  TOTAL_WORKSPACES=$(echo "$SESSIONS" | jq '[.[].workspace] | unique | length')
  
  echo "✓ Active sessions: $TOTAL_WORKSPACES workspace(s), $TOTAL_WINDOWS window(s), $TOTAL_TABS tab(s), $TOTAL_PANES pane(s)"
  
  # Check for issues
  echo ""
  echo "Checking for issues..."
  local issues_found=false
  
  # Check for many panes in one workspace
  while IFS= read -r workspace; do
    local ws_count=$(get_workspace_sessions "$workspace" "$CLI_FLAGS" | jq 'length')
    if [[ $ws_count -gt 20 ]]; then
      echo "⚠ Workspace '$workspace' has $ws_count panes (consider cleanup)"
      issues_found=true
    fi
  done < <(get_workspaces "$CLI_FLAGS")
  
  # Check for old sessions (this is a simplified check - would need more logic for real age)
  # For now, just count total panes
  if [[ $TOTAL_PANES -gt 30 ]]; then
    echo "⚠ High pane count ($TOTAL_PANES total) - consider cleanup"
    issues_found=true
  fi
  
  if [[ "$issues_found" == false ]]; then
    echo "✓ No issues detected"
  fi
  
  # Recommendations
  if [[ "$issues_found" == true ]]; then
    echo ""
    echo "Recommendations:"
    echo "  - Run 'wezterm-health --action cleanup' to clean up old sessions"
    echo "  - Review workspaces with 'wezterm-workspace --action list'"
    echo "  - Kill unused workspaces with 'wezterm-kill --target workspace --id NAME'"
  fi
}

action_cleanup() {
  echo "WezTerm Cleanup:"
  echo ""
  
  SESSIONS=$(get_session_list "$CLI_FLAGS")
  
  if [[ -z "$SESSIONS" ]] || [[ "$SESSIONS" == "[]" ]]; then
    echo "No sessions to clean up"
    return 0
  fi
  
  # Find workspaces with many panes
  local workspaces_to_clean=()
  while IFS= read -r workspace; do
    local ws_count=$(get_workspace_sessions "$workspace" "$CLI_FLAGS" | jq 'length')
    if [[ $ws_count -gt 20 ]]; then
      workspaces_to_clean+=("$workspace")
    fi
  done < <(get_workspaces "$CLI_FLAGS")
  
  if [[ ${#workspaces_to_clean[@]} -eq 0 ]]; then
    echo "No cleanup needed"
    return 0
  fi
  
  echo "Found ${#workspaces_to_clean[@]} workspace(s) that could be cleaned up:"
  for ws in "${workspaces_to_clean[@]}"; do
    local ws_count=$(get_workspace_sessions "$ws" "$CLI_FLAGS" | jq 'length')
    echo "  - $ws ($ws_count panes)"
  done
  
  echo ""
  echo "To clean up a workspace, run:"
  echo "  wezterm-kill --target workspace --id WORKSPACE_NAME"
  echo ""
  echo "Or use wezterm-workspace:"
  echo "  wezterm-workspace --action delete --name WORKSPACE_NAME"
}

action_report() {
  echo "WezTerm Usage Report:"
  echo ""
  
  SESSIONS=$(get_session_list "$CLI_FLAGS")
  
  if [[ -z "$SESSIONS" ]] || [[ "$SESSIONS" == "[]" ]]; then
    echo "No active sessions"
    return 0
  fi
  
  # Summary stats
  TOTAL_PANES=$(echo "$SESSIONS" | jq 'length')
  TOTAL_TABS=$(echo "$SESSIONS" | jq '[.[].tab_id] | unique | length')
  TOTAL_WINDOWS=$(echo "$SESSIONS" | jq '[.[].window_id] | unique | length')
  TOTAL_WORKSPACES=$(echo "$SESSIONS" | jq '[.[].workspace] | unique | length')
  
  echo "Sessions:"
  echo "  Total workspaces: $TOTAL_WORKSPACES"
  echo "  Total windows: $TOTAL_WINDOWS"
  echo "  Total tabs: $TOTAL_TABS"
  echo "  Total panes: $TOTAL_PANES"
  echo ""
  
  # Workspace breakdown
  echo "Workspace breakdown:"
  while IFS= read -r workspace; do
    local ws_sessions=$(get_workspace_sessions "$workspace" "$CLI_FLAGS")
    local ws_panes=$(echo "$ws_sessions" | jq 'length')
    local ws_tabs=$(echo "$ws_sessions" | jq '[.[].tab_id] | unique | length')
    echo "  $workspace: $ws_tabs tab(s), $ws_panes pane(s)"
  done < <(get_workspaces "$CLI_FLAGS")
  
  # Most active workspace
  echo ""
  local most_active_ws=$(get_workspaces "$CLI_FLAGS" | while read ws; do
    local count=$(get_workspace_sessions "$ws" "$CLI_FLAGS" | jq 'length')
    echo "$count $ws"
  done | sort -rn | head -1)
  
  if [[ -n "$most_active_ws" ]]; then
    local count=$(echo "$most_active_ws" | awk '{print $1}')
    local name=$(echo "$most_active_ws" | awk '{print $2}')
    echo "Most active workspace: $name ($count panes)"
  fi
}

# === EXECUTE ACTION ===
case "$ACTION" in
  check) action_check ;;
  cleanup) action_cleanup ;;
  report) action_report ;;
  *)
    log_error "Unknown action: $ACTION"
    echo "Valid actions: check, cleanup, report" >&2
    exit 2
    ;;
esac
