export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnErrorCode?: string;
}

// Compatibility entry point for existing extension imports.
export { createProcessRunner, runProcess } from "./process-utils.mjs";
