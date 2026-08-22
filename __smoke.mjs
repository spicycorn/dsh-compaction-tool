// Local smoke test (gitignored): load the built entry against REAL dependencies,
// exercise apply() registration with a mock ctx, and check output rendering +
// the llm/stream compaction-route rewrite. Run: node __smoke.mjs
import assert from "node:assert/strict";

const mod = await import("./lib/index.mjs");

// 1) Named exports required by the loader convention.
assert.equal(mod.name, "compaction-tool", "name export");
assert.deepEqual([...mod.inject], ["tools", "tokenMeter", "llm"], "inject list");
assert.equal(typeof mod.apply, "function", "apply is a function");

// 2) Config schema: schemastery is a description library (no .parse); verify the
// descriptor serializes and carries every documented field with sane types.
const full = {
  thresholdRatio: 0.85,
  keepLastNTurns: 3,
  keepLastNMessages: 10,
  secondaryModelProvider: "lmstudio",
  secondaryModelName: "qwen3-4b-instruct-2507-gptq",
  summaryMaxTokens: 2048,
  autoCompaction: false,
};
const desc = mod.Config.toJSON();
assert.ok(desc && typeof desc === "object" && !Array.isArray(desc), "Config descriptor is an object");
const objRef = Object.values(desc.refs ?? {}).find((r) => r.type === "object" && r.dict);
assert.ok(objRef, "descriptor contains the root object ref");
for (const field of Object.keys(full)) {
  assert.ok(field in objRef.dict, `descriptor carries ${field}`);
}

// 3) apply() with a mock ctx (commands service composed; no settings/sessions).
const logs = [];
let registeredTool;
let commandDef;
const hooks = new Map();
function runEffect(fn, label) {
  if (typeof fn !== "function") return;
  const maybeGen = fn(); // generator effects: drive to completion so inner registrations happen now
  if (maybeGen && typeof maybeGen.next === "function" && typeof maybeGen[Symbol.iterator] === "function") {
    let step;
    while (!(step = maybeGen.next()).done) void step.value;
  }
}
const ctx = {
  logger: { info: (m) => logs.push(["info", m]), warn: (m) => logs.push(["warn", m]) },
  tools: { register: (t) => void (registeredTool = t) },
  get: (key) => (key === "commands" ? { register: (d) => void (commandDef = d), } : undefined),
  effect(fn, label) { runEffect(fn, label); },
  on(event, hook) { hooks.set(event, hook); return () => {}; },
};

mod.apply(ctx, full);

assert.ok(registeredTool, "a tool was registered");
const def = registeredTool; // defineTool returns the flat definition object
assert.equal(def.name, "compress_context", "tool name");
for (const p of ["target", "keep_last_n_turns", "keep_last_n_messages", "force"]) {
  assert.ok(p in (def.parameters?.properties ?? {}), `parameter ${p} present`);
}

// Command registration through the composed commands service.
assert.ok(commandDef && commandDef.name === "compact" && typeof commandDef.handler === "function", "/compact command registered");

// 4) Output renderer on a success result.
const renderOut = def.output.render(
  {},
  {
    status: "success",
    message: "Compacted 12 history items (~900 tokens). (summarized in 3 folded chunks to fit the model)",
    stats: { totalTokensBefore: 4800, totalTokensAfter: 650, contextWindow: 8192, occupancyRatioBefore: null, occupancyRatioAfter: null, nodesShadowed: 12, tokensShadowed: 900, keepNodes: 3 },
    summaryText: "## Primary Request and Intent\n- test",
    secondaryModel: { provider: "lmstudio", model: "qwen" },
  },
);
const rendered = renderOut.map((b) => b.text).join("\n");
assert.match(rendered, /SUCCESS/, "render shows status");
assert.match(rendered, /4800 → 650/, "render shows token delta");
assert.match(rendered, /Checkpoint:/, "render includes checkpoint text");

// Failed result without after-stats must not throw.
const failOut = def.output.render(
  {},
  { status: "failed", message: "summarization failed: ErrorDeviceLost", stats: { totalTokensBefore: 0, totalTokensAfter: null, contextWindow: null, occupancyRatioBefore: null, occupancyRatioAfter: null, nodesShadowed: 0, tokensShadowed: null, keepNodes: 0 }, summaryText: null, secondaryModel: null },
);
assert.ok(failOut.length > 0 && /FAILED/.test(failOut.map((b) => b.text).join("\n")), "failed render");

// 5) llm/stream hook rewrites purpose=compaction to the live selection.
const streamHook = hooks.get("llm/stream");
assert.equal(typeof streamHook, "function", "llm/stream hook registered");
let nextCalled = false;
const options = { purpose: "compaction", provider: "main-prov", model: "big-model" };
await Promise.resolve(streamHook(options, () => void (nextCalled = true)));
assert.equal(nextCalled, true, "stream hook calls next");
assert.equal(nextCalled, true, "stream hook calls next");
assert.deepEqual({ p: options.provider, m: options.model }, { p: full.secondaryModelProvider, m: full.secondaryModelName }, "compaction route rewritten to live selection");

// Non-compaction traffic is untouched.
const chat = { purpose: "chat", provider: "main-prov", model: "big-model" };
await Promise.resolve(streamHook(chat, () => {}));
assert.deepEqual({ p: chat.provider, m: chat.model }, { p: "main-prov", m: "big-model" }, "non-compaction route untouched");

// 6) agent/pre-step hook exists and passes through when autoCompaction is off.
const preStep = hooks.get("agent/pre-step");
assert.equal(typeof preStep, "function", "pre-step hook registered");
let nextRan = false;
await Promise.resolve(preStep({ agent: { session: {} }, signal: new AbortController().signal }, () => void (nextRan = true)));
assert.ok(nextRan, "pre-step passes through to the turn when auto is off");

console.log("smoke OK — exports, apply(), render, and hooks all behave as expected.");
for (const [level, msg] of logs) console.log(`  [${level}] ${msg}`);
