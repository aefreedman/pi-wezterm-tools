import { spawn } from "node:child_process";

const DEFAULT_KILL_GRACE_MS = 1_000;

/**
 * Creates a bounded subprocess runner. Dependencies are injectable so timeout
 * behavior can be tested without starting an external program.
 */
export function createProcessRunner({
  spawnImpl = spawn,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  killGraceMs = DEFAULT_KILL_GRACE_MS,
} = {}) {
  return async function runProcess(command, args, timeoutMs) {
    return await new Promise((resolve) => {
      let proc;
      let stdout = "";
      let stderr = "";
      let resultSettled = false;
      let terminalSettled = false;
      let timedOut = false;
      let spawnErrorCode;
      let timeoutTimer;
      let killTimer;

      const clearTimers = () => {
        if (timeoutTimer !== undefined) clearTimeoutImpl(timeoutTimer);
        if (killTimer !== undefined) clearTimeoutImpl(killTimer);
      };
      const removeStreamListeners = () => {
        proc?.stdout?.removeListener?.("data", onStdout);
        proc?.stderr?.removeListener?.("data", onStderr);
      };
      const removeTerminalListeners = () => {
        proc?.removeListener?.("error", onError);
        proc?.removeListener?.("close", onClose);
      };
      const finishResult = (exitCode) => {
        if (resultSettled) return;
        resultSettled = true;
        clearTimers();
        removeStreamListeners();
        if (terminalSettled) removeTerminalListeners();
        resolve({
          exitCode,
          stdout,
          stderr,
          timedOut,
          ...(spawnErrorCode ? { spawnErrorCode } : {}),
        });
      };

      const onStdout = (chunk) => {
        stdout += chunk.toString();
      };
      const onStderr = (chunk) => {
        stderr += chunk.toString();
      };
      const onError = (error) => {
        terminalSettled = true;
        if (!resultSettled) {
          stderr += error instanceof Error ? error.message : String(error);
          spawnErrorCode = typeof error === "object" && error !== null && "code" in error
            ? String(error.code)
            : undefined;
          finishResult(1);
        }
        removeTerminalListeners();
      };
      const onClose = (code) => {
        terminalSettled = true;
        if (!resultSettled) finishResult(code);
        removeTerminalListeners();
      };

      try {
        proc = spawnImpl(command, args, {
          stdio: ["ignore", "pipe", "pipe"],
          shell: false,
        });
      } catch (error) {
        terminalSettled = true;
        stderr = error instanceof Error ? error.message : String(error);
        spawnErrorCode = typeof error === "object" && error !== null && "code" in error
          ? String(error.code)
          : undefined;
        finishResult(1);
        return;
      }

      proc.stdout?.on("data", onStdout);
      proc.stderr?.on("data", onStderr);
      proc.on("error", onError);
      proc.on("close", onClose);

      timeoutTimer = setTimeoutImpl(() => {
        if (resultSettled || terminalSettled) return;
        timedOut = true;
        try {
          proc.kill("SIGTERM");
        } catch {
          // The terminal event or grace deadline will settle the result.
        }
        killTimer = setTimeoutImpl(() => {
          if (resultSettled || terminalSettled) return;
          try {
            proc.kill("SIGKILL");
          } catch {
            // A process may have exited between the timeout and escalation.
          }
          // Bound the caller, but retain terminal listeners until close/error so
          // a late child-process error cannot become an unhandled EventEmitter error.
          finishResult(null);
        }, killGraceMs);
      }, timeoutMs);
    });
  };
}

export const runProcess = createProcessRunner();
