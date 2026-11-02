import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { Agent } from "@earendil-works/pi-agent-core";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import weztermTools from "../index.js";
import { loadExtensions } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
for (const name of Object.keys(manifest.devDependencies).filter((name) => name.startsWith("@earendil-works/pi-"))) {
  assert.equal(JSON.parse(readFileSync(new URL(`../node_modules/${name}/package.json`, import.meta.url), "utf8")).version, manifest.devDependencies[name]);
}
const cwd = fileURLToPath(new URL("..", import.meta.url));
let calls: string[][] = [];
let output = "fixture output";
let code: number | null = 0;
let closeSignal: string | null = null;
// Replace the process boundary before loading the real extension. Never run its shell scripts.
const originalSpawn = childProcess.spawn;
(childProcess as any).spawn = (_command: string, args: string[]) => {
  calls.push(args);
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write() {}, end() {} };
  proc.kill = () => true;
  queueMicrotask(() => {
    proc.stdout.emit("data", output);
    proc.emit("close", code, closeSignal);
  });
  return proc;
};
syncBuiltinESMExports();
try {
  const loaded = await loadExtensions([fileURLToPath(new URL("../index.ts", import.meta.url)), fileURLToPath(new URL("../extensions/wezterm-tab-flash-notifier.ts", import.meta.url))], cwd);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 2);
  const tools = [...loaded.extensions[0]!.tools.values()].map((entry) => entry.definition);
  assert.equal(tools.length, 8);
  const rawTools: any[] = [];
  weztermTools({ registerTool: (tool: any) => rawTools.push(tool) } as any);
  assert.deepEqual(rawTools.map((tool) => JSON.parse(JSON.stringify(tool.parameters))), tools.map((tool) => JSON.parse(JSON.stringify(tool.parameters))), "raw SDK and host loader must produce identical JSON schemas");
  for (const tool of tools) {
    const schema = JSON.stringify(tool.parameters);
    assert.doesNotMatch(schema, /"(?:format|refine|codec)":"/);
    assert.doesNotThrow(() => tool.renderCall?.({} as any, {} as any, {} as any).render(40));
    assert.doesNotThrow(() => tool.renderResult?.(undefined as any, { expanded: false, isPartial: false }, {} as any, {} as any).render(40));
  }
  async function invoke(name: string, args: unknown) {
    let turn = 0;
    const agent = new Agent({
      initialState: {
        model: { id: "fixture", name: "fixture", api: "openai-completions", provider: "fixture", baseUrl: "http://invalid.local", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 },
        tools: tools.map((tool) => ({ ...tool, execute: (id, params, signal, update) => tool.execute(id, params, signal, update, { cwd } as any) })),
      },
      streamFn: () => {
        const stream = new AssistantMessageEventStream();
        const first = turn++ === 0;
        const message: any = { role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture", content: first ? [{ type: "toolCall", id: "fixture-call", name, arguments: args }] : [{ type: "text", text: "done" }], stopReason: first ? "toolUse" : "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() };
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end();
        return stream;
      },
    });
    await agent.prompt("synthetic host validation");
    const result = agent.state.messages.find((message) => message.role === "toolResult") as any;
    assert.ok(result, JSON.stringify(agent.state.messages));
    const tool = tools.find((tool) => tool.name === name)!;
    const rendered = tool.renderResult?.(result, { expanded: true, isPartial: false }, {} as any, {} as any).render(80).join("\n");
    assert.ok(rendered, "validation and execution failures must remain visible");
    return result;
  }
  for (const [name, args] of [
    ["wezterm_kill", {}], ["wezterm_kill", { target: "invalid", force: true }],
    ["wezterm_kill", { target: "all", force: "invalid" }],
    ["wezterm_attach", { windowId: "invalid" }],
    ["wezterm_kill", { target: ["all"] }],
  ] as const) {
    calls = [];
    const result = await invoke(name, args);
    assert.equal(result.isError, true);
    assert.equal(calls.length, 0, "invalid arguments must never dispatch a process");
    assert.match(result.content[0].text, /validation|expected|enum|missing/i);
  }
  calls = [];
  assert.equal((await invoke("wezterm_attach", { windowId: "42", newWindow: "false", interactive: "false", workspace: null })).isError, false);
  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.includes("42"));
  assert.ok(calls[0]!.includes("--non-interactive"));
  assert.ok(!calls[0]!.includes("--new-window"));
  assert.equal((await invoke("wezterm_kill", { target: "pane", id: "fixture", force: "true" })).isError, false);
  assert.ok(calls.at(-1)!.includes("--force"));
  code = 2;
  assert.equal((await invoke("wezterm_list", {})).isError, true);
  code = null;
  assert.equal((await invoke("wezterm_list", {})).isError, true);
  code = 0; closeSignal = "SIGTERM";
  assert.match((await invoke("wezterm_list", {})).content[0].text, /terminated/);
  closeSignal = null;
  output = "x".repeat(100_000);
  const result = await invoke("wezterm_list", {});
  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /Output truncated/);
  assert.ok(result.content[0].text.length < 52_000);
  console.log(`PASS: Pi ${manifest.devDependencies["@earendil-works/pi-coding-agent"]} real loader, agent validation/coercion, zero invalid dispatch, rendering and process errors (mock processes only)`);
} finally {
  childProcess.spawn = originalSpawn;
  syncBuiltinESMExports();
}
