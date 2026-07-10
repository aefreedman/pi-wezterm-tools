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
ALLOW_PROJECT_TEMPLATE=false
ALLOW_COMMAND_VARIABLES=false

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
    --allow-project-template) ALLOW_PROJECT_TEMPLATE=true; shift ;;
    --allow-command-variables) ALLOW_COMMAND_VARIABLES=true; shift ;;
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

validate_template_name "$NAME" || exit 2

# === FIND TEMPLATE ===
PROJECT_TEMPLATE="$PI_PROJECT_TEMPLATES_DIR/$NAME.json"
GLOBAL_TEMPLATE="$PI_GLOBAL_TEMPLATES_DIR/$NAME.json"
PACKAGE_TEMPLATE="$PI_PACKAGE_TEMPLATES_DIR/examples/$NAME.json"
TEMPLATE_FILE=""
TEMPLATE_SOURCE=""
TEMPLATE_ROOT=""

if [[ -f "$PROJECT_TEMPLATE" ]]; then
  if [[ "$ALLOW_PROJECT_TEMPLATE" != true ]]; then
    if [[ -f "$GLOBAL_TEMPLATE" || -f "$PACKAGE_TEMPLATE" ]]; then
      log_error "Project-local template '$NAME' shadows another template source and requires explicit opt-in"
    else
      log_error "Project-local template '$NAME' requires explicit opt-in"
    fi
    log_error "Pass --allow-project-template only after trusting $PROJECT_TEMPLATE"
    exit 2
  fi
  TEMPLATE_FILE="$PROJECT_TEMPLATE"
  TEMPLATE_SOURCE="project-local"
  TEMPLATE_ROOT="$PI_PROJECT_TEMPLATES_DIR"
elif [[ -n "$PI_GLOBAL_TEMPLATES_DIR" && -f "$GLOBAL_TEMPLATE" ]]; then
  TEMPLATE_FILE="$GLOBAL_TEMPLATE"
  TEMPLATE_SOURCE="user-global"
  TEMPLATE_ROOT="$PI_GLOBAL_TEMPLATES_DIR"
elif [[ -n "$PI_PACKAGE_TEMPLATES_DIR" && -f "$PACKAGE_TEMPLATE" ]]; then
  TEMPLATE_FILE="$PACKAGE_TEMPLATE"
  TEMPLATE_SOURCE="package-example"
  TEMPLATE_ROOT="$PI_PACKAGE_TEMPLATES_DIR/examples"
else
  log_error "Template '$NAME' not found"
  echo "Searched in:" >&2
  echo "  $PROJECT_TEMPLATE" >&2
  echo "  $GLOBAL_TEMPLATE" >&2
  echo "  $PACKAGE_TEMPLATE" >&2
  exit 2
fi

TEMPLATE_FILE=$(resolve_template_file "$TEMPLATE_ROOT" "$TEMPLATE_FILE") || exit 2
log_info "Resolved template source: $TEMPLATE_SOURCE"
log_info "Resolved template path: $TEMPLATE_FILE"

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
  TEMPLATE=$(substitute_variables "$TEMPLATE" "$VARIABLES" "$ALLOW_COMMAND_VARIABLES")
fi

# === OVERRIDE WORKSPACE IF SPECIFIED ===
if [[ -n "$WORKSPACE_OVERRIDE" ]]; then
  log_info "Overriding workspace to: $WORKSPACE_OVERRIDE"
  TEMPLATE=$(echo "$TEMPLATE" | jq --arg ws "$WORKSPACE_OVERRIDE" '.workspace = $ws')
fi

# === LAUNCH USING launch-wezterm ===
log_info "Launching template..."

# Build launch-wezterm arguments without losing value boundaries.
LAUNCH_ARGS=(--config-stdin)

if [[ "$USE_MUX" == true ]]; then
  LAUNCH_ARGS+=(--use-mux)
fi

if [[ "$CHECK_EXISTING" == true ]]; then
  LAUNCH_ARGS+=(--check-existing)
else
  LAUNCH_ARGS+=(--no-check-existing)
fi

LAUNCH_ARGS+=(--on-existing "$ON_EXISTING")
if [[ -n "$DOMAIN_NAME" ]]; then
  LAUNCH_ARGS+=(--domain-name "$DOMAIN_NAME")
fi

# Invoke through bash so package extraction does not depend on executable mode.
printf '%s\n' "$TEMPLATE" | bash "$SCRIPT_DIR/launch-wezterm.sh" "${LAUNCH_ARGS[@]}"
