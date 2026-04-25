# WezTerm Templates

This directory contains reusable WezTerm layout templates.

## Directory Structure

Package-shipped examples live here:

```
pi-packages/wezterm-tools/templates/
├── README.md           # This file
├── examples/           # Example templates
│   ├── fullstack-dev.json
│   ├── microservices.json
│   └── monitoring.json
```

Active Pi template locations are:

- user-global: `~/.pi/agent/wezterm-templates/`
- project-local: `.pi/wezterm-templates/`

## Template Format

Templates are JSON files that follow the same format as launch-wezterm configurations, with optional variable support:

```json
{
  "name": "template-name",
  "description": "Template description",
  "version": "1.0.0",
  "workspace": "default",
  "variables": {
    "PROJECT_DIR": "~/projects/myapp",
    "PORT": "3000"
  },
  "tabs": [
    {
      "title": "Server",
      "cwd": "{{PROJECT_DIR}}",
      "panes": [
        {
          "command": "npm run dev -- --port {{PORT}}"
        }
      ]
    }
  ]
}
```

## Using Templates

Current Pi tools for templates are:

- `wezterm_load_template`
- `wezterm_template`

### Load Template

```text
wezterm_load_template(name="fullstack-dev")
```

### Load with Variable Substitution

```text
wezterm_load_template(name="fullstack-dev", variables="PROJECT_DIR=~/my-project,PORT=8080")
```

### List Available Templates

```text
wezterm_template(action="list")
```

### Get Template Info

```text
wezterm_template(action="info", name="fullstack-dev")
```

## Creating Templates Manually

1. Create a `.json` file in this directory
2. Use the template format above
3. Use `{{VARIABLE_NAME}}` for substitutable values
4. Test with `wezterm_load_template`

## Project-Local Templates

You can also create project-specific templates:

```
your-project/
  .pi/
    wezterm-templates/
      project-dev.json
```

Project-local templates override user-global templates with the same name.

## Variable Substitution

Variables in templates use `{{VARIABLE_NAME}}` syntax. They are replaced when loading:

- Simple string replacement
- Can be used in: commands, cwds, titles, workspace names
- Provide values via `--variables` flag
- Format: `KEY=value,KEY2=value2` or JSON `{"KEY":"value"}`

## Example Workflows

### Team Sharing

```bash
# Commit a shared template to version control
git add .pi/wezterm-templates/team-dev.json
git commit -m "Add team dev layout template"
```

```text
# Team members can then load it from Pi
wezterm_load_template(name="team-dev", variables="PROJECT_DIR=~/their/path")
```

### Multiple Environments

```bash
# Create templates for different environments
cp dev-template.json staging-template.json
cp dev-template.json production-template.json
```

```text
# Load for a specific environment
wezterm_load_template(name="production-template", workspace="production")
```
