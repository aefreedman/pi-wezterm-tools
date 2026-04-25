#!/usr/bin/env bash

set -euo pipefail

# Source common utilities
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/wezterm-common.sh"

# === ARGUMENT PARSING ===
USE_MUX=false
FORMAT="summary"
WORKSPACE=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --use-mux) USE_MUX=true; shift ;;
    --format) FORMAT="$2"; shift 2 ;;
    --workspace) WORKSPACE="$2"; shift 2 ;;
    *) echo "ERROR: Unknown option: $1" >&2; exit 2 ;;
  esac
done

# === PRE-FLIGHT CHECKS ===
validate_wezterm_installed || exit 1
validate_jq_installed || exit 1

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

# Filter by workspace if specified
if [[ -n "$WORKSPACE" ]]; then
  SESSIONS=$(echo "$SESSIONS" | jq "[.[] | select(.workspace == \"$WORKSPACE\")]")
  
  if [[ "$SESSIONS" == "[]" ]]; then
    echo "No sessions found in workspace '$WORKSPACE'"
    exit 0
  fi
fi

# === FORMAT OUTPUT ===
case "$FORMAT" in
  json)
    # Raw JSON output
    echo "$SESSIONS" | jq '.'
    ;;
    
  summary)
    # Text summary
    format_session_summary "$SESSIONS"
    ;;
    
  table)
    # Table format (grouped by workspace)
    format_table_output "$SESSIONS" "summary"
    ;;
    
  detailed)
    # Detailed table (all panes)
    format_table_output "$SESSIONS" "detailed"
    ;;
    
  *)
    echo "ERROR: Unknown format: $FORMAT" >&2
    echo "Valid formats: json, summary, table, detailed" >&2
    exit 2
    ;;
esac
