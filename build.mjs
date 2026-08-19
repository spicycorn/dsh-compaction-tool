#!/usr/bin/env node
// Transpile the TypeScript source (src/compaction-tool.ts) into the published
// entry (lib/index.mjs) using Node's native type-stripping — no external
// transpiler, no network. Run with `npm run build` or before publishing.
import { stripTypeScriptTypes } from "node:module";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "src", "compaction-tool.ts");
const out = join(here, "lib", "index.mjs");

const ts = readFileSync(src, "utf8");
const js = stripTypeScriptTypes(ts, { mode: "strip" });
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, js, "utf8");
console.log(`build: ${src} → ${out} (${js.length} chars)`);
