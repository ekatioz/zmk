#!/usr/bin/env node
// Regenerates the firmware sources from the design.
//   node generate.mjs            layout.json -> ../display-module/src/generated/*.c
//   node generate.mjs --init     (re)create layout.json with the default design first
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { genAll } from "./lib/codegen.js";
import { defaultDesign } from "./lib/defaults.js";

const here = dirname(fileURLToPath(import.meta.url));
const layoutPath = join(here, "layout.json");
const outDir = join(here, "../display-module/src/generated");

if (process.argv.includes("--init") || !existsSync(layoutPath)) {
  writeFileSync(layoutPath, JSON.stringify(defaultDesign()) + "\n");
  console.log("wrote layout.json (default design)");
}
const design = JSON.parse(readFileSync(layoutPath, "utf8"));
mkdirSync(outDir, { recursive: true });
for (const [name, content] of Object.entries(genAll(design))) {
  writeFileSync(join(outDir, name), content);
  console.log("wrote", join("display-module/src/generated", name));
}
