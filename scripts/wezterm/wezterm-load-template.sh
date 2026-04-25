#!/usr/bin/env bash

set -euo pipefail

# Source common utilities
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/wezterm-common.sh"

# === ARGUMENT PARSING ===
NAME=""
VARIABLES=""
WORKSPACE_OVERRIDE=""
USE_MUX=false
CHECK_EXISTING=true
ON_EXISTING="warn"
DOMAIN_NAME=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --name) NAME="$2"; shift 2 ;;
    --variables) VARIABLES="$2"; shift 2 ;;
    --workspace) WORKSPACE_OVERRIDE="$2"; shift 2 ;;
    --use-mux) USE_MUX=true; shift ;;
    --check-existing) CHECK_EXISTING=true; shift ;;
    --no-check-existing) CHECK_EXISTING=false; shift ;;
    --on-existing) ON_EXISTING="$2"; shift 2 ;;
    --domain-name) DOMAIN_NAME="$2"; shift 2 ;;
    *) echo "ERROR: Unknown option: $1" >&2; exit 2 ;;
  esac
done

# === VALIDATION ===
validate_wezterm_installed || exit 1
validate_jq_installed || exit 1

if [[ -z "$NAME" ]]; then
  log_error "--name is required"
  exit 2
fi

# === FIND TEMPLATE ===
# Look for template (project-local overrides global)
TEMPLATE_FILE=""

# Check project-local first
if [[ -f "$PI_PROJECT_TEMPLATES_DIR/$NAME.json" ]]; then
  TEMPLATE_FILE="$PI_PROJECT_TEMPLATES_DIR/$NAME.json"
  log_info "Using project-local template"
# Check user-global
elif [[ -n "$PI_GLOBAL_TEMPLATES_DIR" && -f "$PI_GLOBAL_TEMPLATES_DIR/$NAME.json" ]]; then
  TEMPLATE_FILE="$PI_GLOBAL_TEMPLATES_DIR/$NAME.json"
  log_info "Using user-global template"
# Check package examples
elif [[ -n "$PI_PACKAGE_TEMPLATES_DIR" && -f "$PI_PACKAGE_TEMPLATES_DIR/examples/$NAME.json" ]]; then
  TEMPLATE_FILE="$PI_PACKAGE_TEMPLATES_DIR/examples/$NAME.json"
  log_info "Using package example template"
else
  log_error "Template '$NAME' not found"
  echo "Searched in:" >&2
  echo "  $PI_PROJECT_TEMPLATES_DIR/$NAME.json" >&2
  echo "  $PI_GLOBAL_TEMPLATES_DIR/$NAME.json" >&2
  echo "  $PI_PACKAGE_TEMPLATES_DIR/examples/$NAME.json" >&2
  exit 2
fi

# === LOAD TEMPLATE ===
TEMPLATE=$(cat "$TEMPLATE_FILE")

# Validate template JSON
if ! echo "$TEMPLATE" | jq empty 2>/dev/null; then
  log_error "Template file contains invalid JSON"
  exit 2
fi

# === EXTRACT TEMPLATE METADATA ===
TEMPLATE_NAME=$(echo "$TEMPLATE" | jq -r '.name // ""')
TEMPLATE_DESC=$(echo "$TEMPLATE" | jq -r '.description // ""')
TEMPLATE_VERSION=$(echo "$TEMPLATE" | jq -r '.version // "unknown"')

if [[ -n "$TEMPLATE_NAME" ]] && [[ -n "$TEMPLATE_DESC" ]]; then
  log_info "Loading template: $TEMPLATE_NAME ($TEMPLATE_VERSION)"
  log_info "Description: $TEMPLATE_DESC"
fi

# === VARIABLE SUBSTITUTION ===
if [[ -n "$VARIABLES" ]]; then
  log_info "Applying variable substitutions..."
  TEMPLATE=$(substitute_variables "$TEMPLATE" "$VARIABLES")
fi

# === OVERRIDE WORKSPACE IF SPECIFIED ===
if [[ -n "$WORKSPACE_OVERRIDE" ]]; then
  log_info "Overriding workspace to: $WORKSPACE_OVERRIDE"
  TEMPLATE=$(echo "$TEMPLATE" | jq --arg ws "$WORKSPACE_OVERRIDE" '.workspace = $ws')
fi

# === LAUNCH USING launch-wezterm ===
log_info "Launching template..."

# Build launch-wezterm arguments
LAUNCH_ARGS="--config-stdin"

if [[ "$USE_MUX" == true ]]; then
  LAUNCH_ARGS="$LAUNCH_ARGS --use-mux"
fi

if [[ "$CHECK_EXISTING" == true ]]; then
  LAUNCH_ARGS="$LAUNCH_ARGS --check-existing"
else
  LAUNCH_ARGS="$LAUNCH_ARGS --no-check-existing"
fi

LAUNCH_ARGS="$LAUNCH_ARGS --on-existing $ON_EXISTING"
if [[ -n "$DOMAIN_NAME" ]]; then
  LAUNCH_ARGS="$LAUNCH_ARGS --domain-name $DOMAIN_NAME"
fi

# Execute launch-wezterm
echo "$TEMPLATE" | "$SCRIPT_DIR/launch-wezterm.sh" $LAUNCH_ARGS
