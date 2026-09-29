# Changelog

## Unreleased

## 0.1.6 - 2026-09-29

### Changed

- Align development and deterministic validation with Pi 0.99.1.
- Pin local tsx 4.23.15 and require Node >=22.19.0 for the Pi runtime and release runner.
- Reconcile npm version and source commit before publication, skip only matching published identities, and verify identity after successful or uncertain publication responses.

## 0.1.5 - 2026-09-21

### Changed

- Update Pi development dependencies and validation baseline to 0.87.0.
- Pin development validation dependencies to Pi 0.86.1 while retaining optional wildcard peers for Pi-provided runtime packages.

## 0.1.4 - 2026-08-06

Initial public npm release.

### Added

- Pi tools for launching, attaching to, inspecting, and managing WezTerm sessions, workspaces, layouts, and templates.
- Package-shipped WezTerm layout examples and guarded loading of project-local templates and command variables.
- A tab notification extension that marks an unfocused target tab when Pi finishes a reply.
- Reproducible locked test tooling and release validation.

### Security

- Project-local templates and variables interpolated into command fields require explicit caller opt-in.
