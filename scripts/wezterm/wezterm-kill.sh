#!/usr/bin/env bash

set -euo pipefail

# Source common utilities
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/wezterm-common.sh"

# === ARGUMENT PARSING ===
USE_MUX=false
TARGET=""
ID=""
INTERACTIVE=true
FORCE=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --use-mux) USE_MUX=true; shift ;;
    --target) TARGET="$2"; shift 2 ;;
    --id) ID="$2"; shift 2 ;;
    --non-interactive) INTERACTIVE=false; shift ;;
    --force) FORCE=true; shift ;;
    *) echo "ERROR: Unknown option: $1" >&2; exit 2 ;;
  esac
done

# === VALIDATION ===
validate_wezterm_installed || exit 1
validate_jq_installed || exit 1

if [[ -z "$TARGET" ]]; then
  echo "ERROR: --target is required (pane, tab, window, workspace, all)" >&2
  exit 2
fi

# === SETUP CLI FLAGS ===
CLI_FLAGS=""
if [[ "$USE_MUX" == true ]]; then
  CLI_FLAGS="--prefer-mux"
fi

# === GET SESSIONS ===
SESSIONS=$(get_session_list "$CLI_FLAGS")

if [[ -z "$SESSIONS" ]] || [[ "$SESSIONS" == "[]" ]]; then
  echo "No active WezTerm sessions found"
  exit 0
fi

# === KILL LOGIC ===

kill_pane() {
  local pane_id="$1"
  
  # Get pane info
  local pane_info=$(echo "$SESSIONS" | jq -r ".[] | select(.pane_id == $pane_id)")
  
  if [[ -z "$pane_info" ]]; then
    echo "ERROR: Pane $pane_id not found" >&2
    exit 3
  fi
  
  local title=$(echo "$pane_info" | jq -r '.title')
  local workspace=$(echo "$pane_info" | jq -r '.workspace')
  
  # Confirm if interactive
  if [[ "$INTERACTIVE" == true ]] && [[ "$FORCE" == false ]]; then
    echo "Kill pane $pane_id?"
    echo "  Workspace: $workspace"
    echo "  Title: $title"
    echo ""
    safe_confirm "Continue? (y/n):" || return 0
  fi
  
  # Kill pane
  wezterm cli $CLI_FLAGS kill-pane --pane-id "$pane_id"
  echo "Killed pane $pane_id"
}

kill_tab() {
  local tab_id="$1"
  
  # Get all panes in tab
  local tab_sessions=$(echo "$SESSIONS" | jq "[.[] | select(.tab_id == $tab_id)]")
  local pane_count=$(echo "$tab_sessions" | jq 'length')
  
  if [[ $pane_count -eq 0 ]]; then
    echo "ERROR: Tab $tab_id not found" >&2
    exit 3
  fi
  
  local tab_title=$(echo "$tab_sessions" | jq -r '.[0].tab_title')
  local workspace=$(echo "$tab_sessions" | jq -r '.[0].workspace')
  
  # Confirm if interactive
  if [[ "$INTERACTIVE" == true ]] && [[ "$FORCE" == false ]]; then
    echo "Kill tab $tab_id?"
    echo "  Workspace: $workspace"
    echo "  Title: $tab_title"
    echo "  Panes: $pane_count"
    echo ""
    safe_confirm "Continue? (y/n):" || return 0
  fi
  
  # Kill all panes in tab
  local pane_ids=$(echo "$tab_sessions" | jq -r '.[].pane_id')
  for pane_id in $pane_ids; do
    wezterm cli $CLI_FLAGS kill-pane --pane-id "$pane_id" 2>/dev/null || true
  done
  
  echo "Killed tab $tab_id ($pane_count panes)"
}

kill_window() {
  local window_id="$1"
  
  # Get all panes in window
  local window_sessions=$(echo "$SESSIONS" | jq "[.[] | select(.window_id == $window_id)]")
  local pane_count=$(echo "$window_sessions" | jq 'length')
  local tab_count=$(echo "$window_sessions" | jq '[.[].tab_id] | unique | length')
  
  if [[ $pane_count -eq 0 ]]; then
    echo "ERROR: Window $window_id not found" >&2
    exit 3
  fi
  
  local workspace=$(echo "$window_sessions" | jq -r '.[0].workspace')
  
  # Confirm if interactive
  if [[ "$INTERACTIVE" == true ]] && [[ "$FORCE" == false ]]; then
    echo "Kill window $window_id?"
    echo "  Workspace: $workspace"
    echo "  Tabs: $tab_count"
    echo "  Panes: $pane_count"
    echo ""
    safe_confirm "Continue? (y/n):" || return 0
  fi
  
  # Kill all panes in window
  local pane_ids=$(echo "$window_sessions" | jq -r '.[].pane_id')
  for pane_id in $pane_ids; do
    wezterm cli $CLI_FLAGS kill-pane --pane-id "$pane_id" 2>/dev/null || true
  done
  
  echo "Killed window $window_id ($tab_count tabs, $pane_count panes)"
}

kill_workspace() {
  local workspace="$1"
  
  # Get all panes in workspace
  local workspace_sessions=$(echo "$SESSIONS" | jq "[.[] | select(.workspace == \"$workspace\")]")
  local pane_count=$(echo "$workspace_sessions" | jq 'length')
  
  if [[ $pane_count -eq 0 ]]; then
    echo "ERROR: Workspace '$workspace' not found or empty" >&2
    exit 3
  fi
  
  local window_count=$(echo "$workspace_sessions" | jq '[.[].window_id] | unique | length')
  local tab_count=$(echo "$workspace_sessions" | jq '[.[].tab_id] | unique | length')
  
  # Get tab titles for summary
  local tab_titles=$(echo "$workspace_sessions" | jq -r '
    [.[].tab_title] | unique | join(", ")
  ')
  
  # Confirm if interactive
  if [[ "$INTERACTIVE" == true ]] && [[ "$FORCE" == false ]]; then
    echo "Kill workspace '$workspace'?"
    echo "  Windows: $window_count"
    echo "  Tabs: $tab_count ($tab_titles)"
    echo "  Panes: $pane_count"
    echo ""
    echo "This will kill all sessions in this workspace."
    safe_confirm "Continue? (y/n):" || return 0
  fi
  
  # Kill all panes in workspace
  local pane_ids=$(echo "$workspace_sessions" | jq -r '.[].pane_id')
  for pane_id in $pane_ids; do
    wezterm cli $CLI_FLAGS kill-pane --pane-id "$pane_id" 2>/dev/null || true
  done
  
  echo "Killed workspace '$workspace' ($window_count windows, $tab_count tabs, $pane_count panes)"
}

kill_all() {
  local total_panes=$(echo "$SESSIONS" | jq 'length')
  local total_tabs=$(echo "$SESSIONS" | jq '[.[].tab_id] | unique | length')
  local total_windows=$(echo "$SESSIONS" | jq '[.[].window_id] | unique | length')
  local total_workspaces=$(echo "$SESSIONS" | jq '[.[].workspace] | unique | length')
  
  # ALWAYS confirm for kill all (even with --force, require explicit confirmation)
  if [[ "$FORCE" == false ]]; then
    echo "WARNING: This will kill ALL WezTerm sessions!"
    echo "  Workspaces: $total_workspaces"
    echo "  Windows: $total_windows"
    echo "  Tabs: $total_tabs"
    echo "  Panes: $total_panes"
    echo ""
    echo "This action cannot be undone."
    safe_confirm "Are you SURE you want to continue? (y/n):" || {
      echo "Aborted."
      exit 0
    }
  fi
  
  # Kill all panes
  local pane_ids=$(echo "$SESSIONS" | jq -r '.[].pane_id')
  for pane_id in $pane_ids; do
    wezterm cli $CLI_FLAGS kill-pane --pane-id "$pane_id" 2>/dev/null || true
  done
  
  echo "Killed all sessions ($total_workspaces workspaces, $total_windows windows, $total_tabs tabs, $total_panes panes)"
}

# === EXECUTE BASED ON TARGET ===

case "$TARGET" in
  pane)
    if [[ -z "$ID" ]]; then
      echo "ERROR: --id required for target 'pane'" >&2
      exit 2
    fi
    kill_pane "$ID"
    ;;
    
  tab)
    if [[ -z "$ID" ]]; then
      echo "ERROR: --id required for target 'tab'" >&2
      exit 2
    fi
    kill_tab "$ID"
    ;;
    
  window)
    if [[ -z "$ID" ]]; then
      echo "ERROR: --id required for target 'window'" >&2
      exit 2
    fi
    kill_window "$ID"
    ;;
    
  workspace)
    if [[ -z "$ID" ]]; then
      echo "ERROR: --id required for target 'workspace' (workspace name)" >&2
      exit 2
    fi
    kill_workspace "$ID"
    ;;
    
  all)
    kill_all
    ;;
    
  *)
    echo "ERROR: Unknown target: $TARGET" >&2
    echo "Valid targets: pane, tab, window, workspace, all" >&2
    exit 2
    ;;
esac
