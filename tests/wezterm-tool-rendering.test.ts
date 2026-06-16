import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const indexText = readFileSync(new URL("../index.ts", import.meta.url), "utf8");

assert.match(indexText, /const COLLAPSED_RESULT_LINES = 12;/, "WezTerm tool results should have a compact collapsed preview limit");
assert.match(indexText, /function renderWeztermCall\(/, "WezTerm tools should provide custom call rendering");
assert.match(indexText, /function renderWeztermResult\(/, "WezTerm tools should provide custom result rendering");
assert.match(indexText, /options\?\.expanded \? lines\.length : COLLAPSED_RESULT_LINES/, "collapsed result rendering should limit visible output until expansion");
assert.match(indexText, /ctrl\+o to expand/, "collapsed result rendering should advertise the Ctrl+O expansion shortcut");
assert.match(indexText, /truncateAnsiLine/, "custom rendering should remain width-safe for long output lines");

const registeredToolCount = (indexText.match(/pi\.registerTool\(\{/g) ?? []).length;
const renderCallCount = (indexText.match(/renderCall\(args, theme\) \{/g) ?? []).length;
const renderResultCount = (indexText.match(/renderResult\(result, options, theme\) \{/g) ?? []).length;
assert.equal(renderCallCount, registeredToolCount, "each registered WezTerm tool should wire renderCall");
assert.equal(renderResultCount, registeredToolCount, "each registered WezTerm tool should wire renderResult");

console.log("PASS: WezTerm tool rendering test succeeded");
