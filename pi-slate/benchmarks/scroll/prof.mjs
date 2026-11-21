// Aggregate sampled microseconds by function and source location, as in the prototype.
import { readFileSync } from "node:fs";

const [file, limit = "12"] = process.argv.slice(2);
if (!file || !Number.isInteger(Number(limit)) || Number(limit) < 1) {
  throw new Error("Usage: node prof.mjs FILE.cpuprofile [TOP_N]");
}
const profile = JSON.parse(readFileSync(file, "utf8"));
const short = (url) => url.replace(/^.*\/node_modules\/@earendil-works\//, "@earendil-works/")
  .replace(/^.*\/pi-slate\//, "pi-slate/").replace(/^file:\/\//, "");
const name = ({ callFrame: f }) => `${f.functionName || "(anonymous)"}${f.url ? ` ${short(f.url)}:${f.lineNumber + 1}` : ""}`;
const nodes = new Map(profile.nodes.map((node) => [node.id, name(node)]));
const parent = new Map();
for (const node of profile.nodes) {
  for (const child of node.children ?? []) parent.set(child, node.id);
}
const add = (map, key, time) => map.set(key, (map.get(key) ?? 0) + time);
const hits = new Map();
for (const [i, id] of profile.samples.entries()) add(hits, id, profile.timeDeltas[i] ?? 0);
const self = new Map(), inclusive = new Map();
let total = 0;
for (const [id, time] of hits) {
  total += time;
  add(self, nodes.get(id), time);
  const seen = new Set();
  for (let cur = id; cur !== undefined; cur = parent.get(cur)) {
    const key = nodes.get(cur);
    if (!seen.has(key)) add(inclusive, key, time);
    seen.add(key); // Attribute a recursive function just once per sample.
  }
}
const ms = (time) => (time / 1000).toFixed(1);
function print(title, map) {
  console.log(`== ${title}`);
  const rows = [...map].filter(([key]) => !/^\((idle|program|root|garbage collector)\)$/.test(key));
  for (const [key, time] of rows.sort((a, b) => b[1] - a[1]).slice(0, Number(limit))) {
    console.log(`${ms(time).padStart(9)} ms  ${key}`);
  }
}
console.log(`Total sampled ${ms(total)} ms (idle ${ms(self.get("(idle)") ?? 0)} ms; GC ${ms(self.get("(garbage collector)") ?? 0)} ms)`);
print("SELF", self);
print("INCLUSIVE", inclusive);
