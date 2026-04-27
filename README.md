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

## Install

Recommended as a global package.

From GitHub:

```bash
pi install git:git@github.com:aefreedman/pi-wezterm-tools.git
```

Local development install:

```bash
pi install <path-to-pi-wezterm-tools>
```

## Requirements

- `wezterm` installed and available on `PATH`
- `jq` installed and available on `PATH`
- `bash` available for running the packaged shell scripts

## Notes

- The current implementation preserves the existing script-backed workflow where practical.
- Package-local shell scripts live under `scripts/wezterm/`.
- Example templates ship under `templates/examples/`.

## License

MIT. See `LICENSE`.
