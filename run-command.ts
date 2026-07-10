import { spawn } from "node:child_process";

export type CommandResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  killed: boolean;
  timedOut: boolean;
};

export type RunCommandOptions = {
  cwd: string;
  stdin?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

type CommandOutput = {
  on(event: "data", listener: (chunk: unknown) => void): unknown;
  removeListener(event: "data", listener: (chunk: unknown) => void): unknown;
};

type CommandInput = {
  write(value: string): unknown;
  end(): unknown;
};

export type CommandProcess = {
  stdout: CommandOutput;
  stderr: CommandOutput;
  stdin?: CommandInput | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  removeListener(event: "error", listener: (error: Error) => void): unknown;
  removeListener(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
};

export type SpawnCommand = (
  command: string,
  args: string[],
  options: { cwd: string; shell: false; stdio: ["pipe" | "ignore", "pipe", "pipe"] },
) => CommandProcess;

export type RunCommandDependencies = {
  spawnCommand?: SpawnCommand;
  terminationGraceMs?: number;
};

const DEFAULT_TIMEOUT_MS = 120_000;
const TERMINATION_GRACE_MS = 5_000;

const defaultSpawnCommand: SpawnCommand = (command, args, options) =>
  spawn(command, args, options) as unknown as CommandProcess;

export async function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions,
  dependencies: RunCommandDependencies = {},
): Promise<CommandResult> {
  const { cwd, stdin, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = options;
  const spawnCommand = dependencies.spawnCommand ?? defaultSpawnCommand;
  const terminationGraceMs = dependencies.terminationGraceMs ?? TERMINATION_GRACE_MS;

  return await new Promise<CommandResult>((resolve) => {
    let proc: CommandProcess;
    let stdout = "";
    let stderr = "";
    let resultSettled = false;
    let terminalSettled = false;
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let escalationTimer: ReturnType<typeof setTimeout> | undefined;

    const removeStreamListeners = () => {
      proc?.stdout?.removeListener("data", onStdout);
      proc?.stderr?.removeListener("data", onStderr);
    };
    const removeTerminalListeners = () => {
      proc?.removeListener("error", onError);
      proc?.removeListener("close", onClose);
    };
    const clearTimers = () => {
      if (timeout !== undefined) clearTimeout(timeout);
      if (escalationTimer !== undefined) clearTimeout(escalationTimer);
    };
    const finishResult = (code: number | null, killed = false) => {
      if (resultSettled) return;
      resultSettled = true;
      clearTimers();
      signal?.removeEventListener("abort", onAbort);
      removeStreamListeners();
      if (terminalSettled) removeTerminalListeners();
      resolve({ stdout, stderr, code, killed, timedOut });
    };
    const onStdout = (chunk: unknown) => {
      stdout += String(chunk);
    };
    const onStderr = (chunk: unknown) => {
      stderr += String(chunk);
    };
    const onError = (error: Error) => {
      terminalSettled = true;
      if (!resultSettled) {
        stderr += `${stderr ? "\n" : ""}${error.message}`;
        finishResult(1, false);
      }
      removeTerminalListeners();
    };
    const onClose = (code: number | null, closeSignal: NodeJS.Signals | null) => {
      terminalSettled = true;
      if (!resultSettled) finishResult(code, closeSignal != null);
      removeTerminalListeners();
    };
    const requestTermination = () => {
      if (resultSettled || terminalSettled || escalationTimer !== undefined) return;
      try {
        proc.kill("SIGTERM");
      } catch {
        // The process may have settled between the state check and signal.
      }
      escalationTimer = setTimeout(() => {
        escalationTimer = undefined;
        if (resultSettled || terminalSettled) return;
        try {
          proc.kill("SIGKILL");
        } catch {
          // The process may have settled between the state check and signal.
        }
        // Bound the caller, but retain terminal listeners until close/error so
        // a late child-process error cannot become unhandled.
        finishResult(null, true);
      }, terminationGraceMs);
    };
    const onAbort = () => {
      requestTermination();
    };

    try {
      proc = spawnCommand(command, args, {
        cwd,
        shell: false,
        stdio: [stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      });
    } catch (error) {
      terminalSettled = true;
      stderr = error instanceof Error ? error.message : String(error);
      finishResult(1, false);
      return;
    }

    proc.stdout.on("data", onStdout);
    proc.stderr.on("data", onStderr);
    proc.on("error", onError);
    proc.on("close", onClose);

    timeout = setTimeout(() => {
      timedOut = true;
      requestTermination();
    }, timeoutMs);

    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

    if (stdin !== undefined && proc.stdin) {
      proc.stdin.write(stdin);
      proc.stdin.end();
    }
  });
}
