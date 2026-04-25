#!/usr/bin/env bash

set -euo pipefail

# Source common utilities
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/wezterm-common.sh"

# === ARGUMENT PARSING ===
ACTION=""
NAME=""
GLOBAL=true

while [[ $# -gt 0 ]]; do
  case $1 in
    --action) ACTION="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --global) GLOBAL=true; shift ;;
    --local) GLOBAL=false; shift ;;
    *) echo "ERROR: Unknown option: $1" >&2; exit 2 ;;
  esac
done

# === VALIDATION ===
validate_jq_installed || exit 1

if [[ -z "$ACTION" ]]; then
  log_error "--action is required (list, delete, info, validate)"
  exit 2
fi

# === DETERMINE TEMPLATE DIRECTORY ===
if [[ "$GLOBAL" == true ]]; then
  TEMPLATE_DIR="$PI_GLOBAL_TEMPLATES_DIR"
else
  TEMPLATE_DIR="$PI_PROJECT_TEMPLATES_DIR"
fi

# === ACTIONS ===

action_list() {
  echo "Available templates:"
  echo ""
  
  # User-global templates
  if [[ -n "$PI_GLOBAL_TEMPLATES_DIR" && -d "$PI_GLOBAL_TEMPLATES_DIR" ]]; then
    echo "User-global templates ($PI_GLOBAL_TEMPLATES_DIR/):"
    for template in "$PI_GLOBAL_TEMPLATES_DIR"/*.json; do
      if [[ -f "$template" ]]; then
        local name=$(basename "$template" .json)
        local desc=$(jq -r '.description // "No description"' "$template" 2>/dev/null || echo "Invalid JSON")
        echo "  $name - $desc"
      fi
    done
    echo ""
  fi
  
  # Package example templates
  if [[ -n "$PI_PACKAGE_TEMPLATES_DIR" && -d "$PI_PACKAGE_TEMPLATES_DIR/examples" ]]; then
    echo "Package example templates ($PI_PACKAGE_TEMPLATES_DIR/examples/):"
    for template in "$PI_PACKAGE_TEMPLATES_DIR/examples"/*.json; do
      if [[ -f "$template" ]]; then
        local name=$(basename "$template" .json)
        local desc=$(jq -r '.description // "No description"' "$template" 2>/dev/null || echo "Invalid JSON")
        echo "  $name - $desc"
      fi
    done
    echo ""
  fi
  
  # Project-local templates
  if [[ -d "$PI_PROJECT_TEMPLATES_DIR" ]]; then
    echo "Project templates ($PI_PROJECT_TEMPLATES_DIR/):"
    for template in "$PI_PROJECT_TEMPLATES_DIR"/*.json; do
      if [[ -f "$template" ]]; then
        local name=$(basename "$template" .json)
        local desc=$(jq -r '.description // "No description"' "$template" 2>/dev/null || echo "Invalid JSON")
        echo "  $name - $desc"
      fi
    done
  fi
}

action_info() {
  if [[ -z "$NAME" ]]; then
    log_error "--name required for info action"
    exit 2
  fi
  
  # Find template
  local template_file=""
  if [[ "$GLOBAL" == true ]]; then
    if [[ -f "$TEMPLATE_DIR/$NAME.json" ]]; then
      template_file="$TEMPLATE_DIR/$NAME.json"
    elif [[ -f "$PI_PACKAGE_TEMPLATES_DIR/examples/$NAME.json" ]]; then
      template_file="$PI_PACKAGE_TEMPLATES_DIR/examples/$NAME.json"
    fi
  else
    if [[ -f "$TEMPLATE_DIR/$NAME.json" ]]; then
      template_file="$TEMPLATE_DIR/$NAME.json"
    fi
  fi
  
  if [[ -z "$template_file" ]]; then
    log_error "Template '$NAME' not found"
    exit 3
  fi
  
  # Display info
  echo "Template: $NAME"
  echo "Location: $template_file"
  
  local desc=$(jq -r '.description // "N/A"' "$template_file")
  local version=$(jq -r '.version // "N/A"' "$template_file")
  local workspace=$(jq -r '.workspace // "default"' "$template_file")
  local tab_count=$(jq '.tabs | length' "$template_file")
  
  echo "Description: $desc"
  echo "Version: $version"
  echo "Workspace: $workspace"
  echo "Tabs: $tab_count"
  
  # List variables if any
  local vars=$(jq -r '.variables // {} | keys[]' "$template_file" 2>/dev/null)
  if [[ -n "$vars" ]]; then
    echo "Variables:"
    while IFS= read -r var; do
      local default=$(jq -r ".variables.\"$var\"" "$template_file")
      echo "  $var = $default"
    done <<< "$vars"
  fi
}

action_validate() {
  if [[ -z "$NAME" ]]; then
    log_error "--name required for validate action"
    exit 2
  fi
  
  # Find template
  local template_file=""
  if [[ "$GLOBAL" == true ]]; then
    if [[ -f "$TEMPLATE_DIR/$NAME.json" ]]; then
      template_file="$TEMPLATE_DIR/$NAME.json"
    elif [[ -f "$PI_PACKAGE_TEMPLATES_DIR/examples/$NAME.json" ]]; then
      template_file="$PI_PACKAGE_TEMPLATES_DIR/examples/$NAME.json"
    fi
  else
    if [[ -f "$TEMPLATE_DIR/$NAME.json" ]]; then
      template_file="$TEMPLATE_DIR/$NAME.json"
    fi
  fi
  
  if [[ -z "$template_file" ]]; then
    log_error "Template '$NAME' not found"
    exit 3
  fi
  
  echo "Validating template '$NAME'..."
  
  # Check JSON validity
  if ! jq empty "$template_file" 2>/dev/null; then
    echo "✗ Invalid JSON"
    exit 1
  fi
  echo "✓ Valid JSON"
  
  # Check required fields
  if jq -e '.tabs' "$template_file" >/dev/null; then
    echo "✓ Has 'tabs' array"
  else
    echo "✗ Missing 'tabs' array"
    exit 1
  fi
  
  # Check tab structure
  local tab_count=$(jq '.tabs | length' "$template_file")
  echo "✓ Contains $tab_count tab(s)"
  
  echo ""
  echo "Template '$NAME' is valid!"
}

action_delete() {
  if [[ -z "$NAME" ]]; then
    log_error "--name required for delete action"
    exit 2
  fi
  
  local template_file="$TEMPLATE_DIR/$NAME.json"
  
  if [[ ! -f "$template_file" ]]; then
    log_error "Template '$NAME' not found at $template_file"
    exit 3
  fi
  
  if safe_confirm "Delete template '$NAME'? (y/n):"; then
    rm "$template_file"
    echo "Deleted template '$NAME'"
  else
    echo "Aborted"
  fi
}

# === EXECUTE ACTION ===
case "$ACTION" in
  list) action_list ;;
  info) action_info ;;
  validate) action_validate ;;
  delete) action_delete ;;
  *)
    log_error "Unknown action: $ACTION"
    echo "Valid actions: list, info, validate, delete" >&2
    exit 2
    ;;
esac
