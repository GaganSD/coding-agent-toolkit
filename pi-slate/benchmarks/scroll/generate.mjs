// No recorded conversation data: every message and tool result is authored here.
import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";

const sizes = { small: 200, medium: 1000, large: 3000 };
const { values } = parseArgs({ options: {
  size: { type: "string", default: "medium" }, entries: { type: "string" },
  seed: { type: "string", default: "42" }, cwd: { type: "string", default: "/" },
  output: { type: "string" },
} });
const count = values.entries === undefined ? sizes[values.size] : Number(values.entries);
const seed = Number(values.seed);
if (!values.output || !Number.isSafeInteger(count) || count < 12 || count > 999999 ||
    !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
  throw new Error("Usage: node generate.mjs --output FILE [--size small|medium|large | --entries 12..999999] [--seed UINT32] [--cwd DIR]");
}

// Fixed clock and IDs; same seed, count, and cwd produce byte-identical JSONL.
let state = seed;
const random = (n) => {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return Math.floor(state / 0x100000000 * n);
};
const text = (text) => ({ type: "text", text });
const thinking = (thinking) => ({ type: "thinking", thinking });
const start = Date.UTC(2025, 0, 1);
const lines = [{ type: "session", version: 3, id: `scroll-bench-${seed}`, cwd: values.cwd, timestamp: new Date(start).toISOString() }];
let parentId = null;
function append(type, fields) {
  const time = start + lines.length * 1000;
  const id = lines.length.toString(16).padStart(8, "0");
  const entry = { type, id, parentId, timestamp: new Date(time).toISOString(), ...fields };
  if (entry.message) entry.message.timestamp = time;
  lines.push(entry);
  parentId = id;
}
const provider = "anthropic";
const model = "claude-sonnet-4-5";
append("model_change", { provider, modelId: model });
append("thinking_level_change", { thinkingLevel: "medium" });
function assistant(content, stopReason) {
  const input = 300 + random(4000), output = 60 + random(600), cacheRead = random(10000), cacheWrite = random(400);
  append("message", { message: {
    role: "assistant", api: "anthropic-messages", provider, model, stopReason, content, durationMs: 400 + random(6000),
    usage: { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite,
      cost: { input: 0.002, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.003 } },
  } });
}

const areas = ["catalog", "ledger", "search", "reporting", "navigation", "billing", "workspace", "preview"];
const labels = ["東京", "München", "café", "🚀", "Δ", "✓"];
const checks = ["npm test", "npm run lint", "npm run typecheck", "node --test"];
const ref = (dir, index) => `${dir}/fixture-${index}.ts`;
function tool(name, dir, turn, index) {
  const path = ref(dir, turn);
  const tag = labels[random(labels.length)];
  const before = `export const retries = ${3 + random(10)};`;
  const after = `export const retries = ${18 + random(10)}; // ${tag}`;
  const code = [`// Generated record ${turn}`, before, "export const limit = 40;"];
  switch (name) {
    case "bash": {
      const command = checks[random(checks.length)];
      const isError = random(5) === 0;
      const cases = Array.from({ length: 5 + random(35) }, (_, i) => `ok ${i + 1} - ${dir}: handles input ${i} (${tag})`);
      const longLine = random(4) === 0 ? `\ndebug: ${`normalized:${dir}/node/ `.repeat(27)}` : "";
      return { args: { command }, output: [`$ ${command}`, "TAP version 13", ...cases,
        isError ? "not ok - fixture exceeded the expected count\nCommand exited with code 1" : "# fail 0\n# result: passed ✓"].join("\n") + longLine, isError };
    }
    case "read": {
      const isError = random(13) === 0;
      return { args: { path: isError ? `${dir}/missing.ts` : path, offset: 1, limit: 35 }, isError,
        output: isError ? `ENOENT: no such file '${dir}/missing.ts'` : [...code,
          ...Array.from({ length: 10 + random(22) }, (_, i) => `export const record${i} = { id: ${turn * 100 + i}, region: "${tag}" };`)].join("\n") };
    }
    case "grep":
      return { args: { pattern: "retries", path: dir, glob: "*.ts", limit: 35 },
        output: Array.from({ length: 4 + random(19) }, (_, i) => `${ref(dir, turn + i)}:2: ${before}`).join("\n") };
    case "ls":
      return { args: { path: dir }, output: ["README.md", "__tests__/", "fixtures/", ...Array.from({ length: 9 + random(12) }, (_, i) => `fixture-${i}.ts`)].join("\n") };
    case "find":
      return { args: { pattern: "**/*.test.ts", path: dir }, output: Array.from({ length: 5 + random(12) }, (_, i) => `__tests__/record-${i}.test.ts`).join("\n") };
    case "edit":
    case "write": {
      const edit = name === "edit";
      const patch = ["--- before", "+++ after", "@@ -1,3 +1,4 @@", ` ${code[0]}`, `-${before}`, `+${after}`,
        ` ${code[2]}`, `+export const fixture = "${turn}-${index}";`, ""].join("\n");
      const content = [code[0], after, code[2], `export const fixture = "${turn}-${index}";`, ""].join("\n");
      return {
        args: edit ? { path, edits: [{ oldText: before, newText: `${after}\nexport const fixture = "${turn}-${index}";` }] } : { path, content },
        output: edit ? `Successfully replaced text in ${path}.` : `Successfully wrote ${Buffer.byteLength(content)} bytes to ${path}`,
        // Pi's edit tool uses details.patch; Slate's write tool uses details.slateDiff.patch.
        details: { slateDiff: { patch }, ...(edit ? { patch, firstChangedLine: 2, diff: ` 1 ${code[0]}\n-2 ${before}\n+2 ${after}\n 3 ${code[2]}\n+4 export const fixture = "${turn}-${index}";` } : {}) },
      };
    }
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

const remaining = () => count - (lines.length - 1);
const tools = ["read", "grep", "ls", "find", "bash", "edit", "write", "bash"];
for (let turn = 1; remaining() > 0; turn++) {
  const area = areas[random(areas.length)], dir = `src/${area}`;
  const goal = ["normalize the records", "add retry coverage", "check the pagination edge cases", "clean up the sample fixtures"][random(4)];
  const label = labels[random(labels.length)];
  const budget = remaining();
  append("message", { message: { role: "user", content: [text(`In \`${dir}\`, please ${goal} for ${label}. Keep the public types stable and run the relevant tests.`)] } });
  if (budget >= 4) {
    let length = Math.min(3 + random(6), budget - 3);
    if (budget - length === 4) length++; // Don't leave a one-entry turn.
    const offset = random(tools.length);
    const calls = Array.from({ length }, (_, i) => {
      const name = tools[(offset + i) % tools.length];
      return { id: `call_fixture_${turn}_${i}`, name, ...tool(name, dir, turn, i) };
    });
    const intro = turn % 3 ? [thinking(`First trace how the ${area} fixtures are loaded. Then adjust the smallest module and use the test output to decide if another pass is needed.`)] : [];
    assistant([...intro, text(`I’ll inspect **${area}** and compare the current fixtures before making changes.`),
      ...calls.map(({ id, name, args }) => ({ type: "toolCall", id, name, arguments: args }))], "toolUse");
    for (const { id, name, output, details, isError = false } of calls) {
      append("message", { message: { role: "toolResult", toolCallId: id, toolName: name, content: [text(output)],
        isError, details, durationMs: 20 + random(1100) } });
    }
  } else if (budget === 3) {
    assistant([thinking(`Cross-check the ${area} report without changing the exported schema.`)], "stop");
  }
  const sample = `{ area: "${area}", revision: ${turn}, label: "${label}" }`;
  const final = remaining() === 1;
  const heading = final ? "Synthetic scroll benchmark ready" : `Fixture pass ${turn}: ${area}`;
  const longAnswer = !final && random(18) === 0 ? Array.from({ length: 10 }, (_, i) => [
    `### Case ${i + 1}: ${area} records`, "",
    `The ${label} fixture keeps the same public shape after normalization. For this case, a missing record should return an empty list, not reuse the previous page.`, "",
    "- **Input:** a record with an optional label and a stable key.",
    `- **Expected:** preserve the key and keep \`${ref(dir, turn + i)}\` deterministic.`,
    "- **Observed:** pagination stays stable when the source returns duplicate IDs.", "",
    "```ts", `const page${i} = [`, `  { key: ${turn * 10 + i}, label: "${label}" },`,
    "  { key: 0, label: null },", "];", "```", "",
  ].join("\n")) : [];
  assistant([text([`## ${heading}`, "", `Reviewed the ${area} fixture set for ${label}.`, "",
    "1. Kept the exported schema stable.", `2. Updated the sample at \`${ref(dir, turn)}\`.`,
    "3. Checked normal input, empty records, and retry boundaries.", "", "```ts", `const fixture = ${sample};`,
    "console.log(fixture);", "```", "", ...longAnswer, "> The metrics above are generated examples, not live command output."].join("\n"))], "stop");
}

writeFileSync(values.output, lines.map((entry) => JSON.stringify(entry)).join("\n") + "\n", { flag: "wx" });
