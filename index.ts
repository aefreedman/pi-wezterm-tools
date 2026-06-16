import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "typebox";

type CommandResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  killed: boolean;
  timedOut: boolean;
};

type RunCommandOptions = {
  cwd: string;
  stdin?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

const DEFAULT_TIMEOUT_MS = 120_000;

function stripAtPrefix(value: string): string {
  return value.startsWith("@") ? value.slice(1) : value;
}

function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function normalizeCwd(ctxCwd: string, cwd?: string): string {
  return cwd ? path.resolve(ctxCwd, stripAtPrefix(cwd)) : ctxCwd;
}

function truncateForModel(text: string): string {
  const truncation = truncateHead(text, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });

  if (!truncation.truncated) {
    return truncation.content;
  }

  return `${truncation.content}\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(
    truncation.outputBytes,
  )} of ${formatSize(truncation.totalBytes)})]`;
}

async function runCommand(command: string, args: string[], options: RunCommandOptions): Promise<CommandResult> {
  const { cwd, stdin, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = options;

  return await new Promise<CommandResult>((resolve) => {
    const proc = spawn(command, args, {
      cwd,
      shell: false,
      stdio: [stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const finish = (code: number | null, killed = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      resolve({ stdout, stderr, code, killed, timedOut });
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!proc.killed) proc.kill("SIGKILL");
      }, 5000);
    }, timeoutMs);

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("error", (error) => {
      stderr += `${stderr ? "\n" : ""}${error.message}`;
      finish(1, false);
    });

    proc.on("close", (code, closeSignal) => {
      finish(code, closeSignal != null);
    });

    const onAbort = () => {
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!proc.killed) proc.kill("SIGKILL");
      }, 5000);
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    if (stdin !== undefined && proc.stdin) {
      proc.stdin.write(stdin);
      proc.stdin.end();
    }
  });
}

function renderCommandResult(toolName: string, result: CommandResult): string {
  const code = result.code ?? 1;
  const combined = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n\n") || "(no output)";
  const rendered = truncateForModel(combined);

  if (result.timedOut) {
    throw new Error(`${toolName} timed out.\n\n${rendered}`);
  }

  if (code !== 0) {
    throw new Error(`${toolName} failed with exit code ${code}.\n\n${rendered}`);
  }

  return rendered;
}

type TextLikeComponent = {
  invalidate: () => void;
  render: (width: number) => string[];
};

type RenderTheme = {
  fg?: (color: string, text: string) => string;
  bold?: (text: string) => string;
};

type WeztermToolResult = {
  content?: Array<{ type?: string; text?: string }>;
};

const COLLAPSED_RESULT_LINES = 12;
const ANSI_PATTERN = /\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]/g;

function visibleLength(value: string): number {
  return value.replace(ANSI_PATTERN, "").length;
}

function truncateAnsiLine(value: string, width: number): string {
  if (width <= 0 || !value) return "";
  if (visibleLength(value) <= width) return value;

  const target = Math.max(0, width - 1);
  let visible = 0;
  let output = "";
  for (let index = 0; index < value.length;) {
    const remaining = value.slice(index);
    const ansi = remaining.match(ANSI_PATTERN);
    if (ansi && ansi.index === 0) {
      output += ansi[0];
      index += ansi[0].length;
      continue;
    }

    if (visible >= target) break;
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) break;
    const char = String.fromCodePoint(codePoint);
    output += char;
    visible += 1;
    index += char.length;
  }

  return `${output}…`;
}

function textComponent(text: string): TextLikeComponent {
  return {
    invalidate() {},
    render(width: number) {
      if (!text) return [];
      return text.split(/\r?\n/).map((line) => truncateAnsiLine(line, width));
    },
  };
}

function themed(theme: RenderTheme, color: string, text: string): string {
  return typeof theme.fg === "function" ? theme.fg(color, text) : text;
}

function bold(theme: RenderTheme, text: string): string {
  return typeof theme.bold === "function" ? theme.bold(text) : text;
}

function extractTextContent(result: WeztermToolResult | undefined): string {
  return result?.content
    ?.filter((entry) => entry?.type === "text")
    .map((entry) => String(entry.text ?? ""))
    .join("\n") ?? "";
}

function trimTrailingEmptyLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1]?.trim() === "") end -= 1;
  return lines.slice(0, end);
}

function renderWeztermCall(toolName: string, args: Record<string, unknown>, theme: RenderTheme): TextLikeComponent {
  const target = args.workspace ?? args.name ?? args.action ?? args.target ?? args.cwd ?? "";
  const suffix = target ? ` ${themed(theme, "accent", String(target))}` : "";
  return textComponent(`${themed(theme, "toolTitle", bold(theme, toolName))}${suffix}`);
}

function renderWeztermResult(
  toolName: string,
  result: WeztermToolResult | undefined,
  options: { expanded?: boolean; isPartial?: boolean } | undefined,
  theme: RenderTheme,
): TextLikeComponent {
  if (options?.isPartial) {
    return textComponent(themed(theme, "warning", `Running ${toolName}...`));
  }

  const output = extractTextContent(result);
  const lines = trimTrailingEmptyLines(output.split(/\r?\n/).map((line) => line.replace(/\t/g, "  ")));
  const maxLines = options?.expanded ? lines.length : COLLAPSED_RESULT_LINES;
  const displayLines = lines.slice(0, maxLines);
  const remaining = lines.length - displayLines.length;
  const rendered = displayLines.map((line) => themed(theme, "toolOutput", line));

  if (remaining > 0) {
    rendered.push(themed(theme, "muted", `... (${remaining} more lines, ctrl+o to expand)`));
  }

  if (rendered.length === 0) {
    rendered.push(themed(theme, "toolOutput", "(no output)"));
  }

  return textComponent(rendered.join("\n"));
}

function getScriptPath(scriptName: string): string {
  return toPosixPath(fileURLToPath(new URL(`./scripts/wezterm/${scriptName}`, import.meta.url)));
}

const WORKSPACE_ACTION = StringEnum(["list", "create", "delete", "rename", "switch", "info"] as const, {
  description: "Workspace action to perform.",
});

const TEMPLATE_ACTION = StringEnum(["list", "delete", "info", "validate"] as const, {
  description: "Template action to perform.",
});

const HEALTH_ACTION = StringEnum(["check", "cleanup", "report"] as const, {
  description: "Health action to perform.",
  default: "check",
});

const KILL_TARGET = StringEnum(["pane", "tab", "window", "workspace", "all"] as const, {
  description: "What to kill.",
});

const LIST_FORMAT = StringEnum(["table", "json", "summary", "detailed"] as const, {
  description: "List output format.",
  default: "summary",
});

const ON_EXISTING = StringEnum(["warn", "merge", "abort", "ignore"] as const, {
  description: "Action when an existing workspace/session is found.",
  default: "warn",
});

const CommonCwd = {
  cwd: Type.Optional(Type.String({ description: "Optional working directory. Defaults to the current working directory." })),
};

const LaunchParams = Type.Object({
  config: Type.String({ description: "JSON configuration string or path to a .json file." }),
  useMux: Type.Optional(Type.Boolean({ description: "Use WezTerm multiplexer daemon for persistent sessions.", default: false })),
  startDaemon: Type.Optional(
    Type.Boolean({ description: "Auto-start mux daemon if not running (only applies when useMux=true).", default: true }),
  ),
  workspace: Type.Optional(Type.String({ description: "Override workspace name from config." })),
  domainName: Type.Optional(Type.String({ description: "Optional domain name for mux sessions, for example local or WSL:Ubuntu." })),
  checkExisting: Type.Optional(Type.Boolean({ description: "Check for existing sessions in workspace.", default: true })),
  onExisting: Type.Optional(ON_EXISTING),
  ...CommonCwd,
});

const AttachParams = Type.Object({
  workspace: Type.Optional(Type.String({ description: "Workspace to attach to." })),
  windowId: Type.Optional(Type.Number({ description: "Specific window ID to attach to." })),
  newWindow: Type.Optional(Type.Boolean({ description: "Create a new window in existing workspace/mux session.", default: false })),
  interactive: Type.Optional(Type.Boolean({ description: "Show interactive workspace picker.", default: true })),
  ...CommonCwd,
});

const HealthParams = Type.Object({
  action: Type.Optional(HEALTH_ACTION),
  verbose: Type.Optional(Type.Boolean({ description: "Show detailed information.", default: false })),
  useMux: Type.Optional(Type.Boolean({ description: "Check mux daemon sessions.", default: false })),
  ...CommonCwd,
});

const KillParams = Type.Object({
  target: KILL_TARGET,
  id: Type.Optional(Type.String({ description: "ID or workspace name to kill." })),
  interactive: Type.Optional(Type.Boolean({ description: "Prompt for confirmation before killing.", default: true })),
  force: Type.Optional(Type.Boolean({ description: "Skip confirmations where supported.", default: false })),
  useMux: Type.Optional(Type.Boolean({ description: "Kill mux daemon sessions.", default: false })),
  ...CommonCwd,
});

const ListParams = Type.Object({
  workspace: Type.Optional(Type.String({ description: "Filter by workspace name." })),
  format: Type.Optional(LIST_FORMAT),
  useMux: Type.Optional(Type.Boolean({ description: "Query mux daemon sessions.", default: false })),
  ...CommonCwd,
});

const LoadTemplateParams = Type.Object({
  name: Type.String({ description: "Template name without .json extension." }),
  variables: Type.Optional(Type.String({ description: "Variable substitutions as key=value,key2=value2 or JSON object." })),
  workspace: Type.Optional(Type.String({ description: "Override workspace name from template." })),
  domainName: Type.Optional(Type.String({ description: "Optional domain name for mux sessions." })),
  useMux: Type.Optional(Type.Boolean({ description: "Use WezTerm multiplexer daemon.", default: false })),
  checkExisting: Type.Optional(Type.Boolean({ description: "Check for existing sessions in workspace.", default: true })),
  onExisting: Type.Optional(ON_EXISTING),
  ...CommonCwd,
});

const TemplateParams = Type.Object({
  action: TEMPLATE_ACTION,
  name: Type.Optional(Type.String({ description: "Template name, required for delete/info/validate." })),
  global: Type.Optional(Type.Boolean({ description: "Target global templates instead of project-local templates.", default: true })),
  ...CommonCwd,
});

const WorkspaceParams = Type.Object({
  action: WORKSPACE_ACTION,
  name: Type.Optional(Type.String({ description: "Workspace name, required for create/delete/rename/switch/info." })),
  newName: Type.Optional(Type.String({ description: "New workspace name, required for rename." })),
  domainName: Type.Optional(Type.String({ description: "Optional domain name for mux sessions." })),
  useMux: Type.Optional(Type.Boolean({ description: "Use mux daemon (workspaces typically require mux mode).", default: true })),
  ...CommonCwd,
});

function looksLikePath(value: string): boolean {
  if (value.endsWith(".json")) return true;
  if (value.startsWith("/") || value.startsWith("~")) return true;
  if (value.startsWith("./") || value.startsWith("../")) return true;
  if (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\")) return true;
  return false;
}

async function executeWeztermScript(
  toolName: string,
  scriptName: string,
  args: string[],
  ctx: { cwd: string },
  signal?: AbortSignal,
  stdin?: string,
) {
  const cwd = ctx.cwd;
  const scriptPath = getScriptPath(scriptName);
  const result = await runCommand("bash", [scriptPath, ...args], { cwd, stdin, signal });
  return {
    content: [{ type: "text", text: renderCommandResult(toolName, result) }],
    details: { cwd, scriptPath, command: ["bash", scriptPath, ...args] },
  };
}

export default function weztermTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "wezterm_launch",
    label: "WezTerm Launch",
    description: "Launch WezTerm with multi-tab and split-pane layouts from JSON configuration.",
    promptSnippet: "Launch and manage structured WezTerm layouts, workspaces, and mux sessions.",
    promptGuidelines: [
      "Use this tool when the user wants Pi to create or update a WezTerm layout from JSON configuration.",
      "Prefer project-local or user-global templates when the user mentions named layouts.",
    ],
    parameters: LaunchParams,
    renderCall(args, theme) {
      return renderWeztermCall("wezterm_launch", (args ?? {}) as Record<string, unknown>, theme as RenderTheme);
    },
    renderResult(result, options, theme) {
      return renderWeztermResult("wezterm_launch", result as WeztermToolResult | undefined, options, theme as RenderTheme);
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cwd = normalizeCwd(ctx.cwd, params.cwd);
      let configInput = params.config;
      let configMethod: "file" | "stdin" = "stdin";
      if (looksLikePath(configInput)) {
        configMethod = "file";
        configInput = toPosixPath(stripAtPrefix(configInput));
      }

      const args: string[] = [];
      if (params.useMux) args.push("--use-mux");
      args.push(params.startDaemon === false ? "--no-start-daemon" : "--start-daemon");
      if (params.workspace) args.push("--workspace", params.workspace);
      if (params.domainName) args.push("--domain-name", params.domainName);
      args.push(params.checkExisting === false ? "--no-check-existing" : "--check-existing");
      args.push("--on-existing", params.onExisting ?? "warn");
      if (configMethod === "file") {
        args.push("--config-file", configInput);
        return await executeWeztermScript("wezterm_launch", "launch-wezterm.sh", args, { cwd }, signal);
      }

      args.push("--config-stdin");
      return await executeWeztermScript("wezterm_launch", "launch-wezterm.sh", args, { cwd }, signal, params.config);
    },
  });

  pi.registerTool({
    name: "wezterm_attach",
    label: "WezTerm Attach",
    description: "Attach to an existing WezTerm workspace or create a new window in an existing session.",
    promptSnippet: "Attach to existing WezTerm workspaces or create new windows inside them.",
    parameters: AttachParams,
    renderCall(args, theme) {
      return renderWeztermCall("wezterm_attach", (args ?? {}) as Record<string, unknown>, theme as RenderTheme);
    },
    renderResult(result, options, theme) {
      return renderWeztermResult("wezterm_attach", result as WeztermToolResult | undefined, options, theme as RenderTheme);
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cwd = normalizeCwd(ctx.cwd, params.cwd);
      const args: string[] = [];
      if (params.workspace) args.push("--workspace", params.workspace);
      if (params.windowId !== undefined) args.push("--window-id", String(params.windowId));
      if (params.newWindow) args.push("--new-window");
      if (params.interactive === false) args.push("--non-interactive");
      return await executeWeztermScript("wezterm_attach", "wezterm-attach.sh", args, { cwd }, signal);
    },
  });

  pi.registerTool({
    name: "wezterm_health",
    label: "WezTerm Health",
    description: "Check WezTerm health, detect issues, and suggest cleanup actions.",
    promptSnippet: "Inspect WezTerm health, session counts, and cleanup recommendations.",
    parameters: HealthParams,
    renderCall(args, theme) {
      return renderWeztermCall("wezterm_health", (args ?? {}) as Record<string, unknown>, theme as RenderTheme);
    },
    renderResult(result, options, theme) {
      return renderWeztermResult("wezterm_health", result as WeztermToolResult | undefined, options, theme as RenderTheme);
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cwd = normalizeCwd(ctx.cwd, params.cwd);
      const args = ["--action", params.action ?? "check"];
      if (params.verbose) args.push("--verbose");
      if (params.useMux) args.push("--use-mux");
      return await executeWeztermScript("wezterm_health", "wezterm-health.sh", args, { cwd }, signal);
    },
  });

  pi.registerTool({
    name: "wezterm_kill",
    label: "WezTerm Kill",
    description: "Safely kill WezTerm panes, tabs, windows, workspaces, or everything.",
    promptSnippet: "Clean up WezTerm panes, tabs, windows, and workspaces.",
    promptGuidelines: ["Prefer non-interactive options only when the user clearly asked for cleanup or deletion."],
    parameters: KillParams,
    renderCall(args, theme) {
      return renderWeztermCall("wezterm_kill", (args ?? {}) as Record<string, unknown>, theme as RenderTheme);
    },
    renderResult(result, options, theme) {
      return renderWeztermResult("wezterm_kill", result as WeztermToolResult | undefined, options, theme as RenderTheme);
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cwd = normalizeCwd(ctx.cwd, params.cwd);
      const args = ["--target", params.target];
      if (params.useMux) args.push("--use-mux");
      if (params.id) args.push("--id", params.id);
      if (params.interactive === false) args.push("--non-interactive");
      if (params.force) args.push("--force");
      return await executeWeztermScript("wezterm_kill", "wezterm-kill.sh", args, { cwd }, signal);
    },
  });

  pi.registerTool({
    name: "wezterm_list",
    label: "WezTerm List",
    description: "List active WezTerm sessions, tabs, and panes.",
    promptSnippet: "List active WezTerm sessions, workspaces, tabs, and panes.",
    parameters: ListParams,
    renderCall(args, theme) {
      return renderWeztermCall("wezterm_list", (args ?? {}) as Record<string, unknown>, theme as RenderTheme);
    },
    renderResult(result, options, theme) {
      return renderWeztermResult("wezterm_list", result as WeztermToolResult | undefined, options, theme as RenderTheme);
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cwd = normalizeCwd(ctx.cwd, params.cwd);
      const args = ["--format", params.format ?? "summary"];
      if (params.useMux) args.push("--use-mux");
      if (params.workspace) args.push("--workspace", params.workspace);
      return await executeWeztermScript("wezterm_list", "wezterm-list.sh", args, { cwd }, signal);
    },
  });

  pi.registerTool({
    name: "wezterm_load_template",
    label: "WezTerm Load Template",
    description: "Load and launch a named WezTerm template with optional variable substitution.",
    promptSnippet: "Launch named WezTerm templates with optional variable substitution.",
    parameters: LoadTemplateParams,
    renderCall(args, theme) {
      return renderWeztermCall("wezterm_load_template", (args ?? {}) as Record<string, unknown>, theme as RenderTheme);
    },
    renderResult(result, options, theme) {
      return renderWeztermResult("wezterm_load_template", result as WeztermToolResult | undefined, options, theme as RenderTheme);
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cwd = normalizeCwd(ctx.cwd, params.cwd);
      const args = ["--name", params.name];
      if (params.variables) args.push("--variables", params.variables);
      if (params.workspace) args.push("--workspace", params.workspace);
      if (params.useMux) args.push("--use-mux");
      if (params.domainName) args.push("--domain-name", params.domainName);
      args.push(params.checkExisting === false ? "--no-check-existing" : "--check-existing");
      args.push("--on-existing", params.onExisting ?? "warn");
      return await executeWeztermScript("wezterm_load_template", "wezterm-load-template.sh", args, { cwd }, signal);
    },
  });

  pi.registerTool({
    name: "wezterm_template",
    label: "WezTerm Template",
    description: "List, inspect, validate, or delete WezTerm templates.",
    promptSnippet: "Inspect and manage user-global or project-local WezTerm templates.",
    parameters: TemplateParams,
    renderCall(args, theme) {
      return renderWeztermCall("wezterm_template", (args ?? {}) as Record<string, unknown>, theme as RenderTheme);
    },
    renderResult(result, options, theme) {
      return renderWeztermResult("wezterm_template", result as WeztermToolResult | undefined, options, theme as RenderTheme);
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cwd = normalizeCwd(ctx.cwd, params.cwd);
      const args = ["--action", params.action];
      if (params.name) args.push("--name", params.name);
      args.push(params.global === false ? "--local" : "--global");
      return await executeWeztermScript("wezterm_template", "wezterm-template.sh", args, { cwd }, signal);
    },
  });

  pi.registerTool({
    name: "wezterm_workspace",
    label: "WezTerm Workspace",
    description: "Manage WezTerm workspaces by listing, creating, deleting, renaming, switching, or inspecting them.",
    promptSnippet: "Manage WezTerm workspaces and switch Pi-related terminal contexts.",
    parameters: WorkspaceParams,
    renderCall(args, theme) {
      return renderWeztermCall("wezterm_workspace", (args ?? {}) as Record<string, unknown>, theme as RenderTheme);
    },
    renderResult(result, options, theme) {
      return renderWeztermResult("wezterm_workspace", result as WeztermToolResult | undefined, options, theme as RenderTheme);
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cwd = normalizeCwd(ctx.cwd, params.cwd);
      const args = ["--action", params.action];
      if (params.name) args.push("--name", params.name);
      if (params.newName) args.push("--new-name", params.newName);
      if (params.useMux !== false) args.push("--use-mux");
      if (params.domainName) args.push("--domain-name", params.domainName);
      return await executeWeztermScript("wezterm_workspace", "wezterm-workspace.sh", args, { cwd }, signal);
    },
  });
}
