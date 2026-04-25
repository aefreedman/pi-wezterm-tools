#!/usr/bin/env bash

set -euo pipefail

# Source common utilities
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/wezterm-common.sh"

# === ARGUMENT PARSING ===
USE_MUX=false
START_DAEMON=true
CONFIG_FILE=""
CONFIG_STDIN=false
WORKSPACE_OVERRIDE=""
CHECK_EXISTING=true
ON_EXISTING="warn"
DOMAIN_NAME=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --use-mux) USE_MUX=true; shift ;;
    --start-daemon) START_DAEMON=true; shift ;;
    --no-start-daemon) START_DAEMON=false; shift ;;
    --config-file) CONFIG_FILE="$2"; shift 2 ;;
    --config-stdin) CONFIG_STDIN=true; shift ;;
    --workspace) WORKSPACE_OVERRIDE="$2"; shift 2 ;;
    --check-existing) CHECK_EXISTING=true; shift ;;
    --no-check-existing) CHECK_EXISTING=false; shift ;;
    --on-existing) ON_EXISTING="$2"; shift 2 ;;
    --domain-name) DOMAIN_NAME="$2"; shift 2 ;;
    *) echo "ERROR: Unknown option: $1" >&2; exit 2 ;;
  esac
done

# === PRE-FLIGHT CHECKS ===
validate_wezterm_installed || exit 1
validate_jq_installed || exit 1

# Read configuration
if [[ "$CONFIG_STDIN" == true ]]; then
  CONFIG_JSON=$(cat)
elif [[ -n "$CONFIG_FILE" ]]; then
  if [[ ! -f "$CONFIG_FILE" ]]; then
    log_error "Config file not found: $CONFIG_FILE"
    exit 2
  fi
  CONFIG_JSON=$(cat "$CONFIG_FILE")
else
  log_error "No configuration provided (use --config-file or --config-stdin)"
  exit 2
fi

# Validate JSON
if ! echo "$CONFIG_JSON" | jq empty 2>/dev/null; then
  log_error "Invalid JSON configuration"
  exit 2
fi

# Check for tabs array
if [[ "$(echo "$CONFIG_JSON" | jq -r '.tabs')" == "null" ]]; then
  log_error "Configuration missing 'tabs' array"
  exit 2
fi

# Get workspace from config or override
WORKSPACE=$(echo "$CONFIG_JSON" | jq -r '.workspace // "default"')
if [[ -n "$WORKSPACE_OVERRIDE" ]]; then
  WORKSPACE="$WORKSPACE_OVERRIDE"
fi

# Validate working directories exist
while read -r cwd; do
  if [[ -n "$cwd" ]] && [[ "$cwd" != "null" ]]; then
    expanded_cwd=$(expand_tilde "$cwd")
    if [[ ! -d "$expanded_cwd" ]]; then
      log_error "Working directory does not exist: $cwd"
      exit 3
    fi
  fi
done < <(echo "$CONFIG_JSON" | jq -r '
  .tabs[] | 
  .cwd, 
  (.panes[]?.cwd // empty)
' | grep -v "^null$" || true)

# === SETUP CLI FLAGS ===
CLI_FLAGS=""
WINDOW_ID=""

if [[ "$USE_MUX" == true ]]; then
  if [[ -z "$DOMAIN_NAME" ]] && is_windows; then
    DOMAIN_NAME="local"
  fi
  # Check if mux server is running
  if ! get_mux_status; then
    if [[ "$START_DAEMON" == true ]]; then
      log_info "Starting WezTerm mux server..."
      wezterm start --always-new-process &
      
      MAX_WAIT=50
      WAIT_COUNT=0
      while ! wezterm cli --prefer-mux list &>/dev/null; do
        sleep 0.1
        WAIT_COUNT=$((WAIT_COUNT + 1))
        if [[ $WAIT_COUNT -ge $MAX_WAIT ]]; then
          log_error "Failed to start mux server within 5 seconds"
          exit 4
        fi
      done
      log_info "Mux server started"
    else
      log_error "Mux server not running and --no-start-daemon specified"
      exit 4
    fi
  fi
  CLI_FLAGS="--prefer-mux"
fi

DOMAIN_ARGS=()
if [[ -n "$DOMAIN_NAME" ]]; then
  DOMAIN_ARGS=(--domain-name "$DOMAIN_NAME")
fi

COMMAND_WRAPPER=("bash" "-c")
COMMAND_SUFFIX="; exec bash"
if [[ "$USE_MUX" == true ]] && is_windows && [[ -z "$DOMAIN_NAME" || "$DOMAIN_NAME" == "local" ]]; then
  COMMAND_WRAPPER=("cmd" "/k")
  COMMAND_SUFFIX=""
fi

# === PRE-LAUNCH CHECK FOR EXISTING SESSIONS ===
if [[ "$CHECK_EXISTING" == true ]]; then
  if workspace_exists "$WORKSPACE" "$CLI_FLAGS"; then
    EXISTING_SESSIONS=$(get_workspace_sessions "$WORKSPACE" "$CLI_FLAGS")
    EXISTING_COUNT=$(echo "$EXISTING_SESSIONS" | jq 'length')
    
    if [[ $EXISTING_COUNT -gt 0 ]]; then
      case "$ON_EXISTING" in
        warn)
          log_warn "Found existing sessions in workspace '$WORKSPACE':"
          format_session_summary "$EXISTING_SESSIONS" | sed 's/^/  /'
          echo ""
          if safe_confirm "Add new tabs to existing window? (y/n):"; then
            WINDOW_ID=$(get_workspace_window_id "$WORKSPACE" "$CLI_FLAGS")
            log_info "Will add tabs to existing window $WINDOW_ID"
          else
            log_info "Aborted"
            exit 0
          fi
          ;;
        merge)
          WINDOW_ID=$(get_workspace_window_id "$WORKSPACE" "$CLI_FLAGS")
          log_info "Merging into existing workspace '$WORKSPACE' (window $WINDOW_ID)"
          ;;
        abort)
          log_error "Sessions already exist in workspace '$WORKSPACE'"
          exit 1
          ;;
        ignore)
          # Create new window (default behavior)
          log_info "Ignoring existing sessions, creating new window"
          ;;
        *)
          log_error "Invalid on-existing option: $ON_EXISTING"
          exit 2
          ;;
      esac
    fi
  fi
fi

# === CLEANUP ON ERROR ===
CREATED_PANE_IDS=()

cleanup_on_error() {
  log_error "Failed to create layout. Rolling back..."
  cleanup_pane_array "$CLI_FLAGS" ${CREATED_PANE_IDS[@]+"${CREATED_PANE_IDS[@]}"}
  exit 5
}

trap cleanup_on_error ERR

wait_for_pane() {
  local pane_id="$1"
  local cli_flags="${2:-}"
  local max_wait=50
  local wait_count=0

  while true; do
    if wezterm cli $cli_flags list --format json | \
      jq -e --arg pane "$pane_id" 'any(.pane_id == ($pane | tonumber))' >/dev/null 2>&1; then
      return 0
    fi

    sleep 0.1
    wait_count=$((wait_count + 1))
    if [[ $wait_count -ge $max_wait ]]; then
      return 1
    fi
  done
}

require_pane_ready() {
  local pane_id="$1"
  if ! wait_for_pane "$pane_id" "$CLI_FLAGS"; then
    log_warn "Pane $pane_id not ready"
    return 0
  fi
}

wait_for_tab_id() {
  local pane_id="$1"
  local cli_flags="${2:-}"
  local max_wait=50
  local wait_count=0
  local tab_id=""

  while true; do
    tab_id=$(wezterm cli $cli_flags list --format json 2>/dev/null | \
      jq -r --arg pane "$pane_id" 'first(.[] | select(.pane_id == ($pane | tonumber)) | .tab_id) // empty' 2>/dev/null || true)

    if [[ -n "$tab_id" ]]; then
      echo "$tab_id"
      return 0
    fi

    sleep 0.1
    wait_count=$((wait_count + 1))
    if [[ $wait_count -ge $max_wait ]]; then
      return 1
    fi
  done
}

set_tab_title_for_pane() {
  local pane_id="$1"
  local title="$2"
  local tab_id=""

  tab_id=$(wait_for_tab_id "$pane_id" "$CLI_FLAGS" || true)
  if [[ -z "$tab_id" ]]; then
    log_warn "Unable to resolve tab for pane $pane_id"
    return 0
  fi

  if ! wezterm cli $CLI_FLAGS set-tab-title --tab-id "$tab_id" "$title"; then
    log_warn "Failed to set title for tab $tab_id"
  fi
  return 0
}

split_pane_with_retry() {
  local parent_pane_id="$1"
  local split_flag="$2"
  local percent="$3"
  local pane_cwd="$4"
  local cmd="$5"
  local max_attempts=20
  local attempt=0
  local output=""

  while [[ $attempt -lt $max_attempts ]]; do
    if [[ -n "$cmd" ]]; then
      if output=$(wezterm cli $CLI_FLAGS split-pane \
        --pane-id "$parent_pane_id" \
        "$split_flag" \
        --percent "$percent" \
        --cwd "$pane_cwd" \
        -- "${COMMAND_WRAPPER[@]}" "${cmd}${COMMAND_SUFFIX}" 2>/dev/null); then
        echo "$output"
        return 0
      fi
    else
      if output=$(wezterm cli $CLI_FLAGS split-pane \
        --pane-id "$parent_pane_id" \
        "$split_flag" \
        --percent "$percent" \
        --cwd "$pane_cwd" 2>/dev/null); then
        echo "$output"
        return 0
      fi
    fi

    attempt=$((attempt + 1))
    sleep 0.2
  done

  return 1
}

sanitize_cli_id() {
  local value="$1"
  value="${value//$'\r'/}"
  value="${value//$'\n'/}"
  value=$(echo "$value" | tr -cd '0-9')
  echo "$value"
}

require_cli_id() {
  local value="$1"
  local label="$2"
  if [[ -z "$value" ]]; then
    log_error "Failed to resolve $label pane id"
    return 1
  fi
}

# === LAUNCH TABS AND PANES ===

TOTAL_TABS=$(echo "$CONFIG_JSON" | jq '.tabs | length')

# First tab
FIRST_TAB=$(echo "$CONFIG_JSON" | jq -c '.tabs[0]')
TITLE=$(echo "$FIRST_TAB" | jq -r '.title // "Tab 1"')
TAB_CWD=$(echo "$FIRST_TAB" | jq -r '.cwd // "~"')
TAB_CWD=$(expand_tilde "$TAB_CWD")

# Handle panes
PANE_COUNT=$(echo "$FIRST_TAB" | jq '.panes | length // 1')
if [[ $PANE_COUNT -eq 0 ]]; then
  PANE_COUNT=1
  FIRST_PANE='{}'
else
  FIRST_PANE=$(echo "$FIRST_TAB" | jq -c '.panes[0] // {}')
fi

CMD=$(echo "$FIRST_PANE" | jq -r '.command // ""')
PANE_CWD=$(echo "$FIRST_PANE" | jq -r ".cwd // \"$TAB_CWD\"")
PANE_CWD=$(expand_tilde "$PANE_CWD")

# Launch based on mode and whether merging
if [[ -n "$WINDOW_ID" ]]; then
  # Merging into existing window - spawn without --new-window
  if [[ -n "$CMD" ]]; then
    FIRST_PANE_ID=$(wezterm cli $CLI_FLAGS spawn \
      --window-id "$WINDOW_ID" \
      ${DOMAIN_ARGS[@]+"${DOMAIN_ARGS[@]}"} \
      --cwd "$PANE_CWD" -- "${COMMAND_WRAPPER[@]}" "${CMD}${COMMAND_SUFFIX}")
  else
    FIRST_PANE_ID=$(wezterm cli $CLI_FLAGS spawn --window-id "$WINDOW_ID" ${DOMAIN_ARGS[@]+"${DOMAIN_ARGS[@]}"} --cwd "$PANE_CWD")
  fi
  FIRST_PANE_ID=$(sanitize_cli_id "$FIRST_PANE_ID")
  require_cli_id "$FIRST_PANE_ID" "first"
elif [[ "$USE_MUX" == true ]]; then
  # Mux mode: spawn new window
  if [[ -n "$CMD" ]]; then
    FIRST_PANE_ID=$(wezterm cli $CLI_FLAGS spawn --new-window \
      ${DOMAIN_ARGS[@]+"${DOMAIN_ARGS[@]}"} \
      --workspace "$WORKSPACE" \
      --cwd "$PANE_CWD" -- "${COMMAND_WRAPPER[@]}" "${CMD}${COMMAND_SUFFIX}")
  else
    FIRST_PANE_ID=$(wezterm cli $CLI_FLAGS spawn --new-window \
      ${DOMAIN_ARGS[@]+"${DOMAIN_ARGS[@]}"} \
      --workspace "$WORKSPACE" \
      --cwd "$PANE_CWD")
  fi
  FIRST_PANE_ID=$(sanitize_cli_id "$FIRST_PANE_ID")
  require_cli_id "$FIRST_PANE_ID" "first"
else
  # Non-mux mode: start GUI
  if [[ -n "$CMD" ]]; then
    wezterm start --cwd "$PANE_CWD" -- "${COMMAND_WRAPPER[@]}" "${CMD}${COMMAND_SUFFIX}" &
  else
    wezterm start --cwd "$PANE_CWD" &
  fi
  
  MAX_WAIT=50
  WAIT_COUNT=0
  while ! wezterm cli list &>/dev/null; do
    sleep 0.1
    WAIT_COUNT=$((WAIT_COUNT + 1))
    if [[ $WAIT_COUNT -ge $MAX_WAIT ]]; then
      log_error "WezTerm GUI failed to start within 5 seconds"
      exit 4
    fi
  done
  
  FIRST_PANE_ID=$(wezterm cli list --format json | jq -r '.[0].pane_id')
  FIRST_PANE_ID=$(sanitize_cli_id "$FIRST_PANE_ID")
  require_cli_id "$FIRST_PANE_ID" "first"
fi

CREATED_PANE_IDS+=("$FIRST_PANE_ID")
require_pane_ready "$FIRST_PANE_ID"
if [[ -z "$WINDOW_ID" ]]; then
  WINDOW_ID=$(wezterm cli $CLI_FLAGS list --format json 2>/dev/null | \
    jq -r --arg pane "$FIRST_PANE_ID" 'first(.[] | select(.pane_id == ($pane | tonumber)) | .window_id) // empty' 2>/dev/null || true)
fi
WINDOW_ARGS=()
if [[ -n "$WINDOW_ID" ]]; then
  WINDOW_ARGS=(--window-id "$WINDOW_ID")
else
  WINDOW_ARGS=(--pane-id "$FIRST_PANE_ID")
fi
set_tab_title_for_pane "$FIRST_PANE_ID" "$TITLE"

# Additional panes in first tab
declare -a TAB_PANE_IDS=("$FIRST_PANE_ID")

for ((p=1; p<PANE_COUNT; p++)); do
  PANE=$(echo "$FIRST_TAB" | jq -c ".panes[$p] // {}")
  
  CMD=$(echo "$PANE" | jq -r '.command // ""')
  PANE_CWD=$(echo "$PANE" | jq -r ".cwd // \"$TAB_CWD\"")
  PANE_CWD=$(expand_tilde "$PANE_CWD")
  SPLIT=$(echo "$PANE" | jq -r '.split // "bottom"')
  PERCENT=$(echo "$PANE" | jq -r '.percent // 50')
  SPLIT_FROM=$(echo "$PANE" | jq -r '.splitFrom // 0')
  
  # Validate and get parent pane
  if [[ $SPLIT_FROM -ge 0 ]] && [[ $SPLIT_FROM -lt ${#TAB_PANE_IDS[@]} ]]; then
    PARENT_PANE_ID="${TAB_PANE_IDS[$SPLIT_FROM]}"
  else
    log_warn "Invalid splitFrom=$SPLIT_FROM for pane $p, using pane 0"
    PARENT_PANE_ID="${TAB_PANE_IDS[0]}"
  fi
  
  # Map split direction
  case "$SPLIT" in
    horizontal|right) SPLIT_FLAG="--right" ;;
    left) SPLIT_FLAG="--left" ;;
    vertical|bottom) SPLIT_FLAG="--bottom" ;;
    top) SPLIT_FLAG="--top" ;;
    *) SPLIT_FLAG="--bottom" ;;
  esac
  
  # Create split
  if ! NEW_PANE_ID=$(split_pane_with_retry "$PARENT_PANE_ID" "$SPLIT_FLAG" "$PERCENT" "$PANE_CWD" "$CMD"); then
    log_error "Failed to split pane from $PARENT_PANE_ID"
    exit 5
  fi
  NEW_PANE_ID=$(sanitize_cli_id "$NEW_PANE_ID")
  require_cli_id "$NEW_PANE_ID" "split"
  
  CREATED_PANE_IDS+=("$NEW_PANE_ID")
  require_pane_ready "$NEW_PANE_ID"
  TAB_PANE_IDS+=("$NEW_PANE_ID")
done

# Additional tabs
for ((t=1; t<TOTAL_TABS; t++)); do
  TAB=$(echo "$CONFIG_JSON" | jq -c ".tabs[$t]")
  TITLE=$(echo "$TAB" | jq -r ".title // \"Tab $((t+1))\"")
  TAB_CWD=$(echo "$TAB" | jq -r '.cwd // "~"')
  TAB_CWD=$(expand_tilde "$TAB_CWD")
  
  PANE_COUNT=$(echo "$TAB" | jq '.panes | length // 1')
  if [[ $PANE_COUNT -eq 0 ]]; then
    PANE_COUNT=1
    FIRST_PANE='{}'
  else
    FIRST_PANE=$(echo "$TAB" | jq -c '.panes[0] // {}')
  fi
  
  CMD=$(echo "$FIRST_PANE" | jq -r '.command // ""')
  PANE_CWD=$(echo "$FIRST_PANE" | jq -r ".cwd // \"$TAB_CWD\"")
  PANE_CWD=$(expand_tilde "$PANE_CWD")
  
  # Spawn new tab
  if [[ -n "$CMD" ]]; then
    NEW_PANE_ID=$(wezterm cli $CLI_FLAGS spawn \
      "${WINDOW_ARGS[@]}" \
      ${DOMAIN_ARGS[@]+"${DOMAIN_ARGS[@]}"} \
      --cwd "$PANE_CWD" \
      -- "${COMMAND_WRAPPER[@]}" "${CMD}${COMMAND_SUFFIX}")
  else
    NEW_PANE_ID=$(wezterm cli $CLI_FLAGS spawn "${WINDOW_ARGS[@]}" ${DOMAIN_ARGS[@]+"${DOMAIN_ARGS[@]}"} --cwd "$PANE_CWD")
  fi
  NEW_PANE_ID=$(sanitize_cli_id "$NEW_PANE_ID")
  require_cli_id "$NEW_PANE_ID" "tab"
  
  CREATED_PANE_IDS+=("$NEW_PANE_ID")
  require_pane_ready "$NEW_PANE_ID"
  set_tab_title_for_pane "$NEW_PANE_ID" "$TITLE"
  
  # Track panes for this tab
  TAB_PANE_IDS=("$NEW_PANE_ID")
  
  # Additional panes in this tab
  for ((p=1; p<PANE_COUNT; p++)); do
    PANE=$(echo "$TAB" | jq -c ".panes[$p] // {}")
    
    CMD=$(echo "$PANE" | jq -r '.command // ""')
    PANE_CWD=$(echo "$PANE" | jq -r ".cwd // \"$TAB_CWD\"")
    PANE_CWD=$(expand_tilde "$PANE_CWD")
    SPLIT=$(echo "$PANE" | jq -r '.split // "bottom"')
    PERCENT=$(echo "$PANE" | jq -r '.percent // 50')
    SPLIT_FROM=$(echo "$PANE" | jq -r '.splitFrom // 0')
    
    if [[ $SPLIT_FROM -ge 0 ]] && [[ $SPLIT_FROM -lt ${#TAB_PANE_IDS[@]} ]]; then
      PARENT_PANE_ID="${TAB_PANE_IDS[$SPLIT_FROM]}"
    else
      log_warn "Invalid splitFrom=$SPLIT_FROM for pane $p (tab $t), using pane 0"
      PARENT_PANE_ID="${TAB_PANE_IDS[0]}"
    fi
    
    case "$SPLIT" in
      horizontal|right) SPLIT_FLAG="--right" ;;
      left) SPLIT_FLAG="--left" ;;
      vertical|bottom) SPLIT_FLAG="--bottom" ;;
      top) SPLIT_FLAG="--top" ;;
      *) SPLIT_FLAG="--bottom" ;;
    esac
    
    if ! NEW_PANE_ID=$(split_pane_with_retry "$PARENT_PANE_ID" "$SPLIT_FLAG" "$PERCENT" "$PANE_CWD" "$CMD"); then
      log_error "Failed to split pane from $PARENT_PANE_ID"
      exit 5
    fi
    NEW_PANE_ID=$(sanitize_cli_id "$NEW_PANE_ID")
    require_cli_id "$NEW_PANE_ID" "split"
    
    CREATED_PANE_IDS+=("$NEW_PANE_ID")
    require_pane_ready "$NEW_PANE_ID"
    TAB_PANE_IDS+=("$NEW_PANE_ID")
  done
done

# Activate specified tab
ACTIVATE_TAB=$(echo "$CONFIG_JSON" | jq -r '.activateTab // ""')
if [[ -n "$ACTIVATE_TAB" ]] && [[ "$ACTIVATE_TAB" != "null" ]]; then
  TAB_ID=$(wezterm cli $CLI_FLAGS list --format json 2>/dev/null | \
    jq -r --arg ws "$WORKSPACE" "map(select(.workspace == \$ws)) | map(.tab_id) | unique | .[$ACTIVATE_TAB] // empty" 2>/dev/null || true)
  
  if [[ -n "$TAB_ID" ]]; then
    wezterm cli $CLI_FLAGS activate-tab --tab-id "$TAB_ID"
  fi
fi

# Success
MODE_MSG="standard mode"
[[ "$USE_MUX" == true ]] && MODE_MSG="mux daemon mode"

echo "WezTerm launched successfully in workspace '$WORKSPACE' ($MODE_MSG)"
echo "Created $TOTAL_TABS tab(s) with ${#CREATED_PANE_IDS[@]} total pane(s)"
