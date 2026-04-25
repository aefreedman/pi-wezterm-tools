#!/usr/bin/env bash

# wezterm-common.sh
# Shared utilities for WezTerm session management tools

# Normalize tool arguments from wrappers
if [[ $# -gt 0 ]]; then
  __pi_expanded_args=()
  for __pi_arg in "$@"; do
    if [[ "$__pi_arg" == --*' '* ]]; then
      __pi_flag="${__pi_arg%% *}"
      __pi_value="${__pi_arg#* }"
      if [[ "$__pi_value" == \"*\" && "$__pi_value" == *\" ]]; then
        __pi_value="${__pi_value:1:-1}"
      fi
      __pi_expanded_args+=("$__pi_flag" "$__pi_value")
    elif [[ -n "$__pi_arg" ]]; then
      __pi_expanded_args+=("$__pi_arg")
    fi
  done
  set -- "${__pi_expanded_args[@]}"
  unset __pi_expanded_args __pi_flag __pi_value __pi_arg
fi

COMMON_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEZTERM_PACKAGE_DIR="$(cd "$COMMON_SCRIPT_DIR/../.." && pwd)"
PI_HOME_DIR="$(cd ~ 2>/dev/null && pwd || printf '%s' "${HOME:-}")"
PI_AGENT_DIR="${PI_AGENT_DIR:-$PI_HOME_DIR/.pi/agent}"
PI_PROJECT_TEMPLATES_DIR=".pi/wezterm-templates"
PI_GLOBAL_TEMPLATES_DIR="${PI_WEZTERM_GLOBAL_TEMPLATES_DIR:-$PI_AGENT_DIR/wezterm-templates}"
PI_PACKAGE_TEMPLATES_DIR="$WEZTERM_PACKAGE_DIR/templates"

windows_path_to_posix() {
  local path="$1"

  if [[ "$path" =~ ^([A-Za-z]):\\ ]]; then
    local drive="${BASH_REMATCH[1],,}"
    local rest="${path:3}"
    rest="${rest//\\//}"
    echo "/$drive/$rest"
    return 0
  fi

  if [[ "$path" =~ ^\\\\ ]]; then
    local unc="${path//\\//}"
    echo "$unc"
    return 0
  fi

  echo "${path//\\//}"
}

resolve_windows_command() {
  local cmd="$1"
  local found=""

  if command -v where.exe >/dev/null 2>&1; then
    while IFS= read -r line; do
      found="$line"
      break
    done < <(where.exe "$cmd" 2>/dev/null || true)
  elif command -v where >/dev/null 2>&1; then
    while IFS= read -r line; do
      found="$line"
      break
    done < <(where "$cmd" 2>/dev/null || true)
  fi

  if [[ -z "$found" ]]; then
    if [[ "$cmd" == "jq" ]]; then
      local home_dir=""
      if home_dir=$(cd ~ 2>/dev/null && pwd); then
        local candidate=""
        local candidates=(
          "$home_dir/AppData/Local/Microsoft/WinGet/Links/jq.exe"
          "$home_dir/scoop/shims/jq.exe"
          "$home_dir/AppData/Local/Programs/jq/jq.exe"
        )
        for candidate in "${candidates[@]}"; do
          if [[ -x "$candidate" ]]; then
            export PATH="$(dirname "$candidate"):$PATH"
            return 0
          fi
        done

        local glob_candidate=""
        shopt -s nullglob
        for glob_candidate in "$home_dir/AppData/Local/Microsoft/WinGet/Packages"/*/jq.exe; do
          if [[ -x "$glob_candidate" ]]; then
            export PATH="$(dirname "$glob_candidate"):$PATH"
            shopt -u nullglob
            return 0
          fi
        done
        shopt -u nullglob
      fi
    fi
    return 1
  fi

  found="${found%$'\r'}"
  local posix_path
  posix_path=$(windows_path_to_posix "$found")

  if [[ -z "$posix_path" ]]; then
    return 1
  fi

  export PATH="$(dirname "$posix_path"):$PATH"
  return 0
}

ensure_command_on_path() {
  local cmd="$1"

  if command -v "$cmd" >/dev/null 2>&1; then
    return 0
  fi

  if resolve_windows_command "$cmd"; then
    return 0
  fi

  return 1
}

# === VALIDATION FUNCTIONS ===

is_windows() {
  local uname_out=""
  uname_out=$(uname -s 2>/dev/null || echo "")
  case "$uname_out" in
    MINGW*|MSYS*|CYGWIN*) return 0 ;;
    *) return 1 ;;
  esac
}

validate_wezterm_installed() {
  if ! ensure_command_on_path wezterm; then
    echo "ERROR: wezterm is not installed or not in PATH" >&2
    return 1
  fi
  return 0
}

validate_jq_installed() {
  if ! ensure_command_on_path jq; then
    echo "ERROR: jq is required for JSON parsing" >&2
    echo "Install: brew install jq (macOS) or apt-get install jq (Linux)" >&2
    return 1
  fi
  return 0
}

# === SESSION QUERY FUNCTIONS ===

get_mux_status() {
  # Check if mux server is running
  # Returns: 0 if running, 1 if not
  if wezterm cli --prefer-mux list &>/dev/null; then
    return 0
  else
    return 1
  fi
}

get_session_list() {
  # Get all sessions as JSON
  # Returns: JSON array of sessions
  local cli_flags="${1:-}"
  
  if ! wezterm cli ${cli_flags} list --format json 2>/dev/null; then
    echo "[]"
    return 1
  fi
  return 0
}

get_workspaces() {
  # List unique workspace names
  # Returns: Newline-separated workspace names
  local cli_flags="${1:-}"
  
  wezterm cli ${cli_flags} list --format json 2>/dev/null | \
    jq -r '.[].workspace' | sort -u
}

get_workspace_sessions() {
  # Get sessions for a specific workspace
  # Args: $1 = workspace name, $2 = cli_flags (optional)
  # Returns: JSON array of sessions in workspace
  local workspace="$1"
  local cli_flags="${2:-}"
  
  wezterm cli ${cli_flags} list --format json 2>/dev/null | \
    jq "[.[] | select(.workspace == \"$workspace\")]"
}

get_window_sessions() {
  # Get sessions for a specific window
  # Args: $1 = window_id, $2 = cli_flags (optional)
  # Returns: JSON array of sessions in window
  local window_id="$1"
  local cli_flags="${2:-}"
  
  wezterm cli ${cli_flags} list --format json 2>/dev/null | \
    jq "[.[] | select(.window_id == $window_id)]"
}

get_tab_sessions() {
  # Get sessions for a specific tab
  # Args: $1 = tab_id, $2 = cli_flags (optional)
  # Returns: JSON array of sessions in tab
  local tab_id="$1"
  local cli_flags="${2:-}"
  
  wezterm cli ${cli_flags} list --format json 2>/dev/null | \
    jq "[.[] | select(.tab_id == $tab_id)]"
}

# === FORMATTING FUNCTIONS ===

format_table_output() {
  # Convert JSON session list to readable table
  # Args: $1 = JSON array of sessions, $2 = format type (default: "summary")
  # Format types: "summary" (by workspace), "detailed" (all panes)
  local sessions="$1"
  local format="${2:-summary}"
  
  if [[ "$format" == "summary" ]]; then
    # Group by workspace and show summary
    echo "WORKSPACE  WINDOWS  TABS  PANES  ACTIVE_TAB"
    echo "$sessions" | jq -r '
      group_by(.workspace) | 
      map({
        workspace: .[0].workspace,
        windows: (map(.window_id) | unique | length),
        tabs: (map(.tab_id) | unique | length),
        panes: length,
        active_tab: (map(select(.is_active == true)) | .[0].tab_title // "N/A")
      }) |
      .[] | 
      [.workspace, .windows, .tabs, .panes, .active_tab] | 
      @tsv
    ' | column -t
  elif [[ "$format" == "detailed" ]]; then
    # Show all panes
    echo "WINID  TABID  PANEID  WORKSPACE  SIZE    TITLE                          CWD"
    echo "$sessions" | jq -r '
      .[] | 
      [
        .window_id,
        .tab_id,
        .pane_id,
        .workspace,
        "\(.size.cols)x\(.size.rows)",
        (.title[0:30]),
        (.cwd | sub("^file://"; ""))
      ] | 
      @tsv
    ' | column -t
  fi
}

format_session_summary() {
  # Create human-readable summary of sessions
  # Args: $1 = JSON array of sessions
  local sessions="$1"
  
  local total_panes=$(echo "$sessions" | jq 'length')
  local total_tabs=$(echo "$sessions" | jq '[.[].tab_id] | unique | length')
  local total_windows=$(echo "$sessions" | jq '[.[].window_id] | unique | length')
  local total_workspaces=$(echo "$sessions" | jq '[.[].workspace] | unique | length')
  
  echo "Total Sessions: $total_workspaces workspace(s), $total_windows window(s), $total_tabs tab(s), $total_panes pane(s)"
  
  # Show active pane if available
  local active_pane=$(echo "$sessions" | jq -r '.[] | select(.is_active == true) | 
    "Active: Window \(.window_id), Tab \(.tab_id), Pane \(.pane_id) (\(.tab_title))"')
  
  if [[ -n "$active_pane" ]]; then
    echo "$active_pane"
  fi
  
  # Show workspaces
  echo ""
  echo "Workspaces:"
  echo "$sessions" | jq -r '
    group_by(.workspace) | 
    map({
      workspace: .[0].workspace,
      tabs: (map(.tab_id) | unique | length),
      panes: length
    }) |
    .[] | 
    "  \(.workspace): \(.tabs) tab(s), \(.panes) pane(s)"
  '
}

# === UTILITY FUNCTIONS ===

expand_tilde() {
  # Expand ~ in paths
  # Args: $1 = path
  local path="$1"
  local expanded="$path"
  local home_dir=""

  if home_dir=$(cd ~ 2>/dev/null && pwd); then
    case "$path" in
      "~") expanded="$home_dir" ;;
      "~/"*) expanded="$home_dir/${path#~/}" ;;
    esac
  fi

  echo "$expanded"
}

safe_confirm() {
  # Interactive confirmation prompt
  # Args: $1 = prompt message, $2 = default (y/n, default: n)
  # Returns: 0 if yes, 1 if no
  local prompt="$1"
  local default="${2:-n}"
  
  local response
  read -p "$prompt " -n 1 -r response
  echo
  
  if [[ -z "$response" ]]; then
    response="$default"
  fi
  
  if [[ "$response" =~ ^[Yy]$ ]]; then
    return 0
  else
    return 1
  fi
}

cleanup_panes() {
  # Kill a list of pane IDs
  # Args: $1 = space-separated pane IDs, $2 = cli_flags (optional)
  local pane_ids="$1"
  local cli_flags="${2:-}"
  
  for pane_id in $pane_ids; do
    wezterm cli ${cli_flags} kill-pane --pane-id "$pane_id" 2>/dev/null || true
  done
}

cleanup_pane_array() {
  # Kill panes from a list (in reverse order)
  # Args: $1 = cli_flags (optional), remaining args = pane IDs
  if [[ $# -eq 0 ]]; then
    return 0
  fi

  local cli_flags="$1"
  shift

  local pane_ids=("$@")
  local pane_id=""
  local i=0

  for ((i=${#pane_ids[@]}-1; i>=0; i--)); do
    pane_id="${pane_ids[$i]}"
    if [[ -n "$pane_id" ]]; then
      wezterm cli ${cli_flags} kill-pane --pane-id "$pane_id" 2>/dev/null || true
    fi
  done
}

# === WORKSPACE UTILITIES ===

workspace_exists() {
  # Check if a workspace exists
  # Args: $1 = workspace name, $2 = cli_flags (optional)
  # Returns: 0 if exists, 1 if not
  local workspace="$1"
  local cli_flags="${2:-}"
  
  local sessions=$(get_workspace_sessions "$workspace" "$cli_flags")
  local count=$(echo "$sessions" | jq 'length')
  
  if [[ $count -gt 0 ]]; then
    return 0
  else
    return 1
  fi
}

get_workspace_window_id() {
  # Get the first window ID in a workspace
  # Args: $1 = workspace name, $2 = cli_flags (optional)
  # Returns: window_id or empty string
  local workspace="$1"
  local cli_flags="${2:-}"
  
  get_workspace_sessions "$workspace" "$cli_flags" | jq -r '.[0].window_id // empty'
}

# === TEMPLATE UTILITIES ===

substitute_variables() {
  # Substitute variables in template
  # Args: $1 = template string, $2 = variables (JSON or key=value)
  # Returns: Template with substituted values
  local template="$1"
  local vars="$2"
  
  if [[ -z "$vars" ]]; then
    echo "$template"
    return 0
  fi
  
  local python_cmd=""
  local candidate=""
  local output=""
  local status=0
  for candidate in python3 python; do
    if command -v "$candidate" >/dev/null 2>&1; then
      output=$("$candidate" -c "import sys" 2>&1)
      status=$?
      if [[ $status -eq 0 && "$output" != *"Python was not found"* ]]; then
        python_cmd="$candidate"
        break
      fi
    fi
  done

  if [[ -z "$python_cmd" ]]; then
    log_error "Python is required for variable substitution (python3 or python)"
    return 1
  fi

  # Use Python for reliable substitution
  local substitution_script='
import json
import sys
import re

template = sys.stdin.read()
vars_str = sys.argv[1]

# Parse variables
if vars_str.startswith("{"):
    # JSON format
    variables = json.loads(vars_str)
else:
    # key=value format
    variables = {}
    for pair in vars_str.split(","):
        if "=" in pair:
            key, value = pair.split("=", 1)
            variables[key] = value

# Substitute variables
for key, value in variables.items():
    pattern = "{{" + key + "}}"
    template = template.replace(pattern, value)

print(template, end="")
'

  echo "$template" | "$python_cmd" -c "$substitution_script" "$vars"
}

# === LOGGING UTILITIES ===

log_info() {
  echo "[INFO] $*" >&2
}

log_warn() {
  echo "[WARN] $*" >&2
}

log_error() {
  echo "[ERROR] $*" >&2
}

log_debug() {
  if [[ "${DEBUG:-0}" == "1" ]]; then
    echo "[DEBUG] $*" >&2
  fi
}
