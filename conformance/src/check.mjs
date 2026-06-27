// TS leg of the differential harness (REFERENCE.md §3, §5). STUB.
//
// Currently a smoke check: confirms the vendored DASL vectors load and are well-formed
// (so `make conformance` is green from day one). When op-verify lands, this also runs
// the PLC-op fixtures through @did-plc/lib (the authoritative reference) and asserts
// the Cairo side agrees.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const vectorsDir = join(here, "..", "vectors", "dasl-cbor");

let total = 0;
const types = new Set();
for (const f of readdirSync(vectorsDir)) {
  if (!f.endsWith(".json")) continue;
  const cases = JSON.parse(readFileSync(join(vectorsDir, f), "utf8"));
  if (!Array.isArray(cases)) throw new Error(`${f}: expected an array of cases`);
  for (const c of cases) {
    if (typeof c.data !== "string" || typeof c.type !== "string") {
      throw new Error(`${f}: malformed case ${JSON.stringify(c).slice(0, 80)}`);
    }
    types.add(c.type);
    total += 1;
  }
}

console.log(`conformance(ts): ${total} DASL vectors well-formed; types = ${[...types].join(", ")}`);
console.log("conformance(ts): @did-plc/lib differential check: TODO (op-verify phase)");
