# Pi WezTerm Tools

Pi package that lets Pi manipulate WezTerm sessions, workspaces, layouts, and templates, and marks tabs when Pi finishes a reply.

## Tools

- `wezterm_launch`
- `wezterm_attach`
- `wezterm_health`
- `wezterm_kill`
- `wezterm_list`
- `wezterm_load_template`
- `wezterm_template`
- `wezterm_workspace`

## Tab notifications

The bundled notifier marks the target WezTerm tab when Pi finishes a reply and the target pane is not focused.

- Pi's built-in OSC 9;4 support handles in-progress streaming and compaction activity in supporting terminals such as WezTerm.
- The notifier marks the transition back to the user turn with a `READY` badge.
- It prefers exact pane targeting via `PI_WEZTERM_PANE_ID` or `WEZTERM_PANE`, then falls back to a cached pane ID and finally a session-title match.
- It updates the tab title through `wezterm cli set-tab-title`; a companion WezTerm tab formatter can render the stable badge and clear it when the tab becomes active.

Supported notifier environment variables:

- `PI_WEZTERM_NOTIFY_ENABLED`
- `PI_WEZTERM_EXECUTABLE`
- `PI_WEZTERM_NOTIFY_COOLDOWN_MS`
- `PI_WEZTERM_NOTIFY_TIMEOUT_MS`
- `PI_WEZTERM_NOTIFICATION_TEXT`
- `PI_WEZTERM_PANE_ID`
- `WEZTERM_PANE`

## Template locations

Pi-native template lookup order:

1. project-local: `.pi/wezterm-templates/` (requires `allowProjectTemplate: true`)
2. user-global: `~/.pi/agent/wezterm-templates/`
3. package examples: `templates/examples/`

Project-local templates are executable configuration from the current project, so loading one always requires explicit trust via `allowProjectTemplate: true`. This also prevents an unapproved project template from silently shadowing a user-global or package template. Template names may contain letters, numbers, dots, underscores, and hyphens, but not path separators or `..`.

Any variable interpolated into a command field is executable input and is rejected unless the caller explicitly sets `allowCommandVariables: true` after reviewing the value. Variables used only in non-command fields do not require this opt-in.

## Install

Recommended as a global package.

From npm:

```bash
pi install npm:@aefree/pi-wezterm-tools
```

From GitHub for development:

```bash
pi install git:git@github.com:aefreedman/pi-wezterm-tools.git
```

Local development install:

```bash
pi install <path-to-pi-wezterm-tools>
```

## Requirements

- `wezterm` installed and available on `PATH` (or `PI_WEZTERM_EXECUTABLE` set to its full path)
- WezTerm environment variables available in the target terminal session for best notification pane targeting
- `jq` installed and available on `PATH`
- `bash` available for running the packaged shell scripts
- `python3` or `python` available when substituting template variables; template loading fails with a clear error when neither is installed

On macOS, the tools also fall back to `/Applications/WezTerm.app/Contents/MacOS/wezterm` when the `wezterm` command is not on `PATH`. Set `PI_WEZTERM_EXECUTABLE` to an executable file path to explicitly select a WezTerm binary; this override takes precedence over `PATH`.

Pane commands use Bash by default to preserve existing behavior. Set `PI_WEZTERM_PANE_SHELL=/bin/zsh` (or another executable shell) when pane commands should load that shell's startup environment and continue interactively in it.

## Testing

```bash
npm test
```

## Notes

- This package includes the tab notification extension; enable only the notification configuration you want Pi to load.
- Package-local shell scripts live under `scripts/wezterm/`.
- Example templates ship under `templates/examples/`.

## License

MIT. See `LICENSE`.
