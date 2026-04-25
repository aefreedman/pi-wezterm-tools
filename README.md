# Pi WezTerm Tools

Pi package that lets Pi manipulate WezTerm sessions, workspaces, layouts, and templates.

## Tools

- `wezterm_launch`
- `wezterm_attach`
- `wezterm_health`
- `wezterm_kill`
- `wezterm_list`
- `wezterm_load_template`
- `wezterm_template`
- `wezterm_workspace`

## Template locations

Pi-native template lookup order:

1. project-local: `.pi/wezterm-templates/`
2. user-global: `~/.pi/agent/wezterm-templates/`
3. package examples: `templates/examples/`

## Notes

- The current implementation preserves the existing script-backed workflow where practical.
- The package-local shell scripts live under `scripts/wezterm/`.
- Example templates ship under `templates/examples/`.
- This package is intended to be installed globally during migration.
- Current runtime assumptions:
  - `wezterm` is installed and on `PATH`
  - `jq` is installed and on `PATH`
  - `bash` is available for running the packaged shell scripts

## Install

```bash
pi install "<path-to-pi-wezterm-tools>"
```

## License

MIT. See `LICENSE`.
