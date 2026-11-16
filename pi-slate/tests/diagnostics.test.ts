import assert from "node:assert/strict";
import test from "node:test";
import { SlateDiagnostics } from "../extensions/pi-slate/diagnostics.ts";

test("optional adapter failures are isolated, quarantined, and do not retain exception secrets", () => {
  const diagnostics = new SlateDiagnostics();
  let calls = 0;
  const fail = () => { calls++; throw new Error("SECRET credential and host internals"); };
  assert.equal(diagnostics.attempt("sidebar", "Native layout retained; split adapter failed.", fail, () => false), false);
  assert.equal(diagnostics.attempt("sidebar", "Native layout retained; split adapter failed.", fail, () => false), false);
  assert.equal(calls, 1);
  diagnostics.active("sidebar", "must not erase a quarantined failure");
  assert.equal(diagnostics.attempt("transcript", "Unused", () => 42, () => 0), 42, "unrelated features still work");
  const report = diagnostics.report("0.2.0", "99.0.0", ["sidebar", "editor"]);
  assert.match(report, /sidebar: fallback/);
  assert.match(report, /Native layout retained/);
  assert.doesNotMatch(report, /SECRET|credential|host internals|Warning|Error/);
  diagnostics.reset();
  assert.equal(diagnostics.attempt("sidebar", "Unused", () => true, () => false), true);
  assert.deepEqual(diagnostics.snapshot(), []);
});

test("expected missing capabilities remain recoverable and snapshots cannot mutate diagnostics", () => {
  const diagnostics = new SlateDiagnostics();
  diagnostics.fallback("transcript", "Native transcript retained; no compatible chat container.");
  diagnostics.active("transcript", "Message window mounted.");
  const snapshot = diagnostics.snapshot();
  snapshot[0]!.detail = "mutated";
  assert.equal(diagnostics.snapshot()[0]!.detail, "Message window mounted.");
  assert.match(diagnostics.report("0.2.0", "1.5.2", []), /Selected surfaces: none/);
});
