# Changelog

## 0.1.4 - 2026-08-06

Initial public npm release.

### Added

- Pi tools for launching, attaching to, inspecting, and managing WezTerm sessions, workspaces, layouts, and templates.
- Package-shipped WezTerm layout examples and guarded loading of project-local templates and command variables.
- A tab notification extension that marks an unfocused target tab when Pi finishes a reply.

### Security

- Project-local templates and variables interpolated into command fields require explicit caller opt-in.
