import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { runCommand, type CommandProcess, type SpawnCommand } from "../run-command.js";

class FakeProcess extends EventEmitter implements CommandProcess {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly signals: NodeJS.Signals[] = [];
  stdin = null;
  closeOnSignal?: NodeJS.Signals;

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    if (signal === this.closeOnSignal) queueMicrotask(() => this.emit("close", null, signal));
    return true;
  }
}

function fakeSpawn(proc: FakeProcess): SpawnCommand {
  return () => proc;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "timed out waiting for fake process signal");
    await sleep(2);
  }
}

{
  const proc = new FakeProcess();
  proc.closeOnSignal = "SIGKILL";
  const resultPromise = runCommand(
    "fake",
    [],
    { cwd: process.cwd(), timeoutMs: 10 },
    { spawnCommand: fakeSpawn(proc), terminationGraceMs: 10 },
  );

  const result = await resultPromise;
  assert.deepEqual(proc.signals, ["SIGTERM", "SIGKILL"], "timeout must escalate after the grace period even if SIGTERM was sent");
  assert.equal(result.timedOut, true);
  assert.equal(result.killed, true);
}

{
  const proc = new FakeProcess();
  proc.closeOnSignal = "SIGTERM";
  const result = await runCommand(
    "fake",
    [],
    { cwd: process.cwd(), timeoutMs: 10 },
    { spawnCommand: fakeSpawn(proc), terminationGraceMs: 10 },
  );

  await sleep(30);
  assert.deepEqual(proc.signals, ["SIGTERM"], "terminal settlement must clear the pending escalation timer");
  assert.equal(result.timedOut, true);
}

{
  const proc = new FakeProcess();
  const result = await runCommand(
    "fake",
    [],
    { cwd: process.cwd(), timeoutMs: 10 },
    { spawnCommand: fakeSpawn(proc), terminationGraceMs: 10 },
  );

  assert.deepEqual(proc.signals, ["SIGTERM", "SIGKILL"], "a child without close must still receive escalation");
  assert.equal(result.code, null, "bounded completion should report no exit code when close is absent");
  assert.equal(result.killed, true);
  assert.equal(result.timedOut, true);
  assert.equal(proc.stdout.listenerCount("data"), 0, "bounded result completion should release stream listeners");
  assert.equal(proc.listenerCount("error"), 1, "terminal error handling must remain until the child settles");
  proc.emit("error", new Error("late child error after forced timeout"));
  assert.equal(proc.listenerCount("error"), 0, "terminal settlement should release error listeners");
  assert.equal(proc.listenerCount("close"), 0, "terminal settlement should release close listeners");
}

{
  const controller = new AbortController();
  const proc = new FakeProcess();
  proc.closeOnSignal = "SIGKILL";
  const resultPromise = runCommand(
    "fake",
    [],
    { cwd: process.cwd(), timeoutMs: 1_000, signal: controller.signal },
    { spawnCommand: fakeSpawn(proc), terminationGraceMs: 10 },
  );

  controller.abort();
  await waitFor(() => proc.signals.includes("SIGKILL"));
  const result = await resultPromise;
  assert.deepEqual(proc.signals, ["SIGTERM", "SIGKILL"], "abort must use the same settled-process escalation path");
  assert.equal(result.timedOut, false);
}

console.log("PASS: runCommand termination escalation test succeeded");
