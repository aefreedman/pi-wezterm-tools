# Changelog

## 0.1.2 - 2026-07-10

### Changed

- Migrated Pi extension imports and peer dependencies to the `@earendil-works` package scope.

## 0.1.1 - 2026-07-09

### Fixed

- Invoke the nested WezTerm launcher through Bash and preserve launch argument boundaries.
- Require explicit opt-in for project-local templates, reject unsafe template names across loading and management, enforce template-root containment, and report the resolved template source and path.
- Require explicit opt-in for every variable interpolated into a command field, including quoted and partial command placeholders.
- Enforce LF line endings for packaged shell scripts and validate shell/package behavior in tests.
- Escalate timed-out or aborted script processes to `SIGKILL` until they settle, rather than treating a sent `SIGTERM` as termination.
- Keep Windows path normalization compatible with stock macOS Bash 3.2 and discover WezTerm from `PI_WEZTERM_EXECUTABLE` or the standard macOS app bundle when it is not on `PATH`.
- Allow macOS users to select zsh or another pane shell through `PI_WEZTERM_PANE_SHELL` while retaining Bash as the default.

### Added

- Added macOS CI coverage that runs shell validation with stock `/bin/bash`.
