import { strict as assert } from "node:assert";
import { __weztermTabFlashNotifierInternals } from "../extensions/wezterm-tab-flash-notifier";
import { createProcessRunner } from "../extensions/shared/process-utils.mjs";

const {
  buildNotificationTitle,
  parseNotificationTitle,
  getNotificationText,
  scorePaneTitle,
  resolveWeztermExecutable,
  createWeztermCliRunner,
  macOSWeztermAppExecutable,
  weztermFailureDetail,
} = __weztermTabFlashNotifierInternals;

assert.equal(getNotificationText(), "READY", "Expected completed Pi turns to use a single READY badge.");

const encoded = buildNotificationTitle("repo/main", "ATTN");
const parsed = parseNotificationTitle(encoded);
assert(parsed, "Expected notification title to round-trip.");
assert.equal(parsed?.previousTitle, "repo/main", "Expected previous title to survive encoding.");
assert.equal(parsed?.notificationText, "ATTN", "Expected notification text to survive encoding.");

assert.equal(parseNotificationTitle("__OCN__|repo%2Fmain|READY"), undefined, "Expected non-Pi prefixes to be ignored.");

assert(scorePaneTitle("dotfiles", "dotfiles - pi") > scorePaneTitle("dotfiles", "notes"), "Expected title scoring to prefer the matching pane.");

assert.equal(resolveWeztermExecutable({}), "wezterm", "Expected wezterm to be the default executable.");
assert.equal(resolveWeztermExecutable({ PI_WEZTERM_EXECUTABLE: " /opt/wezterm/bin/wezterm " }), "/opt/wezterm/bin/wezterm", "Expected PI_WEZTERM_EXECUTABLE to override the default.");

const macFallbackCalls: Array<{ command: string; args: string[] }> = [];
const macFallbackRunner = createWeztermCliRunner({
  environment: {},
  platform: "darwin",
  runProcessImpl: async (command, args) => {
    macFallbackCalls.push({ command, args });
    return command === "wezterm"
      ? { exitCode: 1, stdout: "", stderr: "spawn wezterm ENOENT", timedOut: false, spawnErrorCode: "ENOENT" }
      : { exitCode: 0, stdout: "[]", stderr: "", timedOut: false };
  },
});
assert.equal((await macFallbackRunner(["list", "--format", "json"])).exitCode, 0, "Expected macOS app-bundle fallback after a missing PATH executable.");
assert.deepEqual(macFallbackCalls.map((call) => call.command), ["wezterm", macOSWeztermAppExecutable], "Expected the standard macOS app executable as fallback.");

const overrideCalls: string[] = [];
const overrideRunner = createWeztermCliRunner({
  environment: { PI_WEZTERM_EXECUTABLE: "/custom/wezterm" },
  platform: "darwin",
  runProcessImpl: async (command) => {
    overrideCalls.push(command);
    return { exitCode: 1, stdout: "", stderr: "missing", timedOut: false, spawnErrorCode: "ENOENT" };
  },
});
await overrideRunner(["list"]);
assert.deepEqual(overrideCalls, ["/custom/wezterm"], "Expected an explicit executable override to prevent fallback substitution.");
assert.match(weztermFailureDetail({ exitCode: 1, stdout: "", stderr: "missing", timedOut: false, spawnErrorCode: "ENOENT" }), /PI_WEZTERM_EXECUTABLE/, "Expected missing executable guidance to name PI_WEZTERM_EXECUTABLE.");

class FakeEmitter {
  listeners = new Map<string, Array<(...args: any[]) => void>>();

  on(event: string, listener: (...args: any[]) => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }

  removeListener(event: string, listener: (...args: any[]) => void) {
    this.listeners.set(event, (this.listeners.get(event) ?? []).filter((candidate) => candidate !== listener));
  }

  emit(event: string, ...args: any[]) {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }

  listenerCount(event: string) {
    return (this.listeners.get(event) ?? []).length;
  }
}

const child = new FakeEmitter() as FakeEmitter & { stdout: FakeEmitter; stderr: FakeEmitter; killed: boolean; signals: string[]; kill: (signal: string) => boolean };
child.stdout = new FakeEmitter();
child.stderr = new FakeEmitter();
child.killed = false;
child.signals = [];
child.kill = (signal) => {
  child.killed = true; // A real ChildProcess reports this after SIGTERM.
  child.signals.push(signal);
  return true;
};

const timers: Array<{ callback: () => void; delay: number; cleared: boolean }> = [];
const run = createProcessRunner({
  spawnImpl: () => child,
  setTimeoutImpl: (callback: () => void, delay: number) => {
    const timer = { callback, delay, cleared: false };
    timers.push(timer);
    return timer;
  },
  clearTimeoutImpl: (timer: { cleared: boolean }) => { timer.cleared = true; },
  killGraceMs: 2,
});
const fire = (delay: number) => {
  const timer = timers.find((candidate) => candidate.delay === delay && !candidate.cleared);
  assert(timer, `Expected an active ${delay}ms timer.`);
  timer.callback();
};

const timedOut = run("wezterm", [], 5);
fire(5);
assert.deepEqual(child.signals, ["SIGTERM"]);
fire(2);
assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"], "Escalation must not depend on ChildProcess.killed.");
assert.deepEqual(await timedOut, { exitCode: null, stdout: "", stderr: "", timedOut: true });
assert.equal(child.listenerCount("error"), 1, "Terminal error handling must remain until the child actually settles.");
child.emit("error", new Error("late child error after forced timeout"));
assert.equal(child.listenerCount("error"), 0);
assert.equal(child.listenerCount("close"), 0, "Terminal settlement removes lifecycle listeners.");

const missingChild = new FakeEmitter() as FakeEmitter & { stdout: FakeEmitter; stderr: FakeEmitter; kill: () => boolean };
missingChild.stdout = new FakeEmitter();
missingChild.stderr = new FakeEmitter();
missingChild.kill = () => true;
const runMissingExecutable = createProcessRunner({ spawnImpl: () => missingChild });
const missingExecutable = runMissingExecutable("wezterm", [], 10);
missingChild.emit("error", Object.assign(new Error("spawn wezterm ENOENT"), { code: "ENOENT" }));
assert.equal((await missingExecutable).spawnErrorCode, "ENOENT", "Expected the injected process runner to preserve ENOENT for executable fallback resolution.");

console.log("wezterm-tab-notifier tests passed");
