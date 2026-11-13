import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, createReadToolDefinition, type ExtensionAPI, type Theme, type ToolRenderers, type ToolRendererResolver } from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { installToolStyle, TOOL_STYLE_NAMES } from "../extensions/pi-slate/tool-style.ts";
import { createShellRenderers } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/renderers/bash.js";
import { codemodeRenderers } from "../node_modules/@earendil-works/pi-coding-agent/dist/extensions/codemode/renderer.js";

type Context = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];
const theme = { fg: (_: string, value: string) => value, bold: (value: string) => value } as Theme;
function setup(original?: ToolRenderers) {
  let resolver: ToolRendererResolver | undefined;
  installToolStyle({ registerToolRenderer(value) { resolver = value; } } as ExtensionAPI);
  return (name: string) => resolver!(name, () => original)!;
}
function context(overrides: Partial<Context> = {}): Context {
  return { args: {}, toolCallId: "a", invalidate() {}, lastComponent: undefined, state: {}, cwd: process.cwd(),
    executionStarted: true, argsComplete: true, isPartial: false, expanded: false, showImages: false,
    isError: false, durationMs: undefined, outputPad: 0, ...overrides };
}
function result(text = "", details?: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}
const plain = (component: Component, width = 180) => component.render(width).map((row) => row.trimEnd()).join("\n");
function call(tool: ToolRenderers, args: Record<string, unknown>, ctx = context()) {
  return tool.renderCall!(args, theme, { ...ctx, args });
}
function output(tool: ToolRenderers, value = result(), ctx = context()) {
  return tool.renderResult!(value, { expanded: ctx.expanded, isPartial: ctx.isPartial }, theme, ctx);
}

test("installs presentation only and passes other tools through", () => {
  const original = { renderShell: "default" as const };
  assert.equal(setup(original)("other"), original);
  assert.equal(setup(original)("toString"), original);
  assert.equal(TOOL_STYLE_NAMES.length, 9);
  assert.ok(Object.isFrozen(TOOL_STYLE_NAMES));
  assert.equal(setup(original)("read").renderShell, "self");
});

test("compact headings cover every supported tool without dumping source or mutation bodies", () => {
  const get = setup();
  const cases: [string, Record<string, unknown>, string][] = [
    ["read", { path: "src/a.ts", offset: 4, limit: 8 }, "Read (src/a.ts, offset=4, limit=8)"],
    ["bash", { command: "npm test", timeout: 0 }, "Bash (npm test)"],
    ["grep", { pattern: "hello", path: "src" }, "Grep (hello, src)"],
    ["find", { pattern: "**/*.ts", path: "." }, "Find (**/*.ts, .)"],
    ["ls", { path: "." }, "Ls (.)"],
    ["write", { path: "a", content: "SECRET" }, "Write (a)"],
    ["edit", { path: "a", oldText: "SECRET", newText: "SECRET2" }, "Edit (a)"],
    ["codemode", { code: "SECRET" }, "Codemode (script)"],
    ["recall", { query: "earlier work" }, "Recall (earlier work)"],
  ];
  for (const [name, args, expected] of cases) assert.equal(plain(call(get(name), args)), `✓ ${expected}`);
  assert.equal(plain(call(get("read"), { file_path: "alias" })), "✓ Read (alias)");
});

test("pending, running, error and duration including zero", () => {
  const tool = setup()("bash");
  for (const [overrides, symbol, summary] of [
    [{ isPartial: true, executionStarted: false }, "·", "Pending…"],
    [{ isPartial: true }, "", "Running…"],
    [{ isError: true }, "✗", "bad command"],
  ] as const) {
    const ctx = context(overrides);
    assert.ok(plain(call(tool, { command: "x" }, ctx)).startsWith(symbol));
    assert.equal(plain(output(tool, result("bad command\nextra"), ctx)), `└ ${summary}`);
  }
  assert.equal(plain(output(tool, result("x\ny\n"), context({ durationMs: 0 }))), "└ 2 lines · 0ms");
  assert.equal(plain(output(tool, result(""), context({ durationMs: 23 }))), "└ 0 lines · 23ms");
});

test("timeout appears in result only, including zero", () => {
  const tool = setup()("bash");
  const ctx = context({ args: { command: "sleep 1", timeout: 0 }, durationMs: 0 });
  assert.equal(plain(call(tool, ctx.args as Record<string, unknown>, ctx)), "✓ Bash (sleep 1)");
  assert.equal(plain(output(tool, result(""), ctx)), "└ 0 lines · timeout=0s · 0ms");
});

test("spinner changes on host redraw with no extra timer", (t) => {
  let now = 0;
  t.mock.method(Date, "now", () => now);
  const component = call(setup()("bash"), { command: "wait" }, context({ isPartial: true }));
  const first = plain(component);
  now = 100;
  assert.notEqual(plain(component), first);
  assert.match(plain(component), /Bash \(wait\)/);
});

test("image-only reads report image rather than zero lines", () => {
  const tool = setup()("read");
  const component = tool.renderResult!({ content: [{ type: "image", data: "AA==", mimeType: "image/png" }], details: undefined }, { expanded: false, isPartial: false }, theme, context());
  assert.equal(plain(component), "└ image");
});

test("summaries count output and pluralize", () => {
  const get = setup();
  for (const [name, text, expected] of [
    ["read", "a\nb", "2 lines"], ["grep", "a\nb\n", "2 lines"],
    ["grep", "No matches found", "No matches"], ["find", "a\n", "1 file"],
    ["find", "a\nb", "2 files"], ["ls", "a", "1 entry"], ["ls", "a\nb", "2 entries"],
    ["recall", "memory", "1 line"], ["codemode", "a\nb", "2 lines"],
    ["write", "Wrote a file", "Wrote a file"],
  ]) assert.equal(plain(output(get(name!), result(text))), `└ ${expected}`);
});

test("counts SDK edit patches, Slate write patches, and display-diff fallback", () => {
  const patch = "--- before\n+++ after\n@@ -1,2 +1,3 @@\n-old\n+new\n+++ content\n same\n\\ No newline at end of file\n";
  const get = setup();
  for (const [name, details] of [
    ["edit", { patch }], ["write", { slateDiff: { patch } }],
    ["edit", { diff: "-1 old\n+1 new\n+2 next\n 3 same" }],
  ] as const) {
    const expected = "+2 -1";
    assert.equal(plain(output(get(name), result("done", details))), `└ ${expected}`);
  }
  assert.equal(plain(output(get("write"), result("done", { slateDiff: { patch: "" } }))), "└ +0 -0");
  assert.equal(plain(output(get("write"), result("done", { slateDiff: { note: "omitted" } }))), "└ done");
});

test("collapsed file mutations hand the row to their diff renderer", () => {
  const seen: boolean[] = [];
  const original = { renderShell: "default" as const, renderResult(_result: unknown, options: { expanded: boolean }) {
    seen.push(options.expanded);
    return { render: () => ["native diff"], invalidate() {} };
  } };
  const patch = "--- before\n+++ after\n@@ -1 +1 @@\n-old\n+new\n";
  const edit = setup(original as unknown as ToolRenderers)("edit");
  assert.equal(plain(output(edit, result("done", { patch }))), "native diff");
  assert.deepEqual(seen, [false], "a collapsed edit still shows the diff");
  assert.equal(plain(output(edit, result("boom", { patch }), context({ isError: true }))), "└ boom");
  assert.equal(plain(output(edit, result("", { patch }), context({ isPartial: true }))), "└ Running…");
  assert.equal(plain(output(edit, result("Edited a"))), "└ Edited a", "no patch keeps the summary");
  const write = setup(original as unknown as ToolRenderers)("write");
  assert.equal(plain(output(write, result("done", { slateDiff: { patch } }))), "native diff");
  const bash = setup(original as unknown as ToolRenderers)("bash");
  assert.equal(plain(output(bash, result("done", { patch }))), "└ +1 -1", "other tools stay one line");
});

test("sanitizes terminal controls, hyperlinks, bidi, and multiline arguments; fits all widths", () => {
  const tool = setup()("bash");
  const unsafe = "界😀é\x1b[2J\x1b]8;;https://evil\x07link\x1b]8;;\x07\n\t\r\x00\u202e\x1b";
  const components = [call(tool, { command: unsafe }), output(tool, result(unsafe), context({ isError: true }))];
  for (const component of components) {
    assert.doesNotMatch(plain(component), /[\x00-\x1f\x7f-\x9f\u202e]/);
    for (let width = 0; width < 60; width++) {
      for (const row of component.render(width)) assert.ok(visibleWidth(row) <= width, `${width}: ${row}`);
    }
    component.invalidate();
  }
});

test("outputPad applies once and remains width safe", () => {
  const tool = setup()("read");
  for (const pad of [0, 1]) {
    const component = call(tool, { path: "界😀" }, context({ outputPad: pad }));
    assert.equal(plain(component), `${" ".repeat(pad)}✓ Read (界😀)`);
    for (let width = 0; width < 15; width++) for (const row of component.render(width)) assert.ok(visibleWidth(row) <= width);
  }
});

test("expanded originals have their own shared state and separate previous call/result slots", () => {
  const seen: Context[] = [];
  const original: ToolRenderers = {
    renderCall(args, _theme, ctx) {
      seen.push(ctx);
      ctx.state.called = true;
      const component = (ctx.lastComponent ?? new Text("", 0, 0)) as Text;
      component.setText(String((args as { code: string }).code));
      return component;
    },
    renderResult(_value, _options, _theme, ctx) {
      seen.push(ctx);
      assert.equal(ctx.state.called, true);
      const component = (ctx.lastComponent ?? new Text("", 0, 0)) as Text;
      component.setText("original output");
      return component;
    },
  };
  const tool = setup(original)("codemode");
  const state = { unrelated: true };
  const collapsed = context({ state, outputPad: 1 });
  const args = { code: "const source = 1;" };
  const compactCall = call(tool, args, collapsed);
  const compactResult = output(tool, result("x"), collapsed);
  const expanded = { ...collapsed, expanded: true, lastComponent: compactCall };
  assert.equal(plain(call(tool, args, expanded)), " const source = 1;");
  assert.equal(plain(output(tool, result("x"), { ...expanded, lastComponent: compactResult })), " original output");
  assert.equal(seen[0]!.lastComponent, undefined);
  assert.equal(seen[1]!.lastComponent, undefined);
  assert.equal(seen[0]!.state, seen[1]!.state);
  assert.notEqual(seen[0]!.state, state);
  call(tool, args, collapsed);
  output(tool, result("x"), collapsed);
  call(tool, args, expanded);
  output(tool, result("x"), expanded);
  assert.ok(seen[2]!.lastComponent instanceof Text);
  assert.ok(seen[3]!.lastComponent instanceof Text);
  assert.notEqual(seen[2]!.lastComponent, seen[3]!.lastComponent);
  assert.deepEqual(state, { unrelated: true });
});

test("expanded fallback shows full source and output without original renderers", () => {
  const tool = setup()("codemode");
  const ctx = context({ expanded: true, outputPad: 1 });
  assert.equal(plain(call(tool, { code: "const a = 1;\nreturn a;" }, ctx)), " const a = 1;\n return a;");
  assert.equal(plain(output(tool, result("first\nsecond\nthird"), ctx)), " first\n second\n third");
});

test("diff counts use green additions and red removals", () => {
  const colors: [string, string][] = [];
  const colored = { ...theme, fg(color: string, text: string) { colors.push([color, text]); return text; } } as Theme;
  const tool = setup()("edit");
  const component = tool.renderResult!(result("", { patch: "--- before\n+++ after\n@@ -1 +1 @@\n-old\n+new\n" }), { expanded: false, isPartial: false }, colored, context());
  assert.equal(plain(component), "└ +1 -1");
  assert.ok(colors.some(([color, text]) => color === "success" && text === "+1"));
  assert.ok(colors.some(([color, text]) => color === "error" && text === "-1"));
});

test("expanded self-shell delegates padding to original", () => {
  const original: ToolRenderers = { renderShell: "self", renderCall(_args, _theme, ctx) { return new Text(" ".repeat(ctx.outputPad) + "native", 0, 0); } };
  assert.equal(plain(call(setup(original)("edit"), {}, context({ expanded: true, outputPad: 1 }))), " native");
});

test("read expands SDK renderer without Slate read override", () => {
  const native = createReadToolDefinition(process.cwd());
  const tool = setup({ renderCall: native.renderCall as ToolRenderers["renderCall"], renderResult: native.renderResult as ToolRenderers["renderResult"] })("read");
  const ctx = context({ expanded: true, args: { path: "unknown.ext" } });
  assert.match(plain(tool.renderCall!(ctx.args, theme, ctx)), /unknown\.ext/);
  assert.match(plain(output(tool, result("full original output"), ctx)), /full original output/);
});

test("compact arguments are bounded and not rescanned by component renders", () => {
  let reads = 0;
  const component = call(setup()("bash"), { get command() { reads++; return "x".repeat(100_000); } });
  const initial = reads;
  assert.ok(plain(component, 100_000).length < 2100);
  for (let i = 0; i < 20; i++) component.render(100 + i);
  assert.equal(reads, initial);
});

test("linear summaries are cached by content/details identity despite SDK envelope recreation", () => {
  const tool = setup()("bash");
  let accesses = 0;
  const content = [{ type: "text" as const, get text() { accesses++; return "one\ntwo\n"; } }];
  const value = { content, details: undefined };
  const first = output(tool, value);
  const count = accesses;
  assert.ok(count > 0);
  for (let i = 0; i < 20; i++) {
    first.render(20 + i);
    output(tool, { ...value }).render(30);
  }
  assert.equal(accesses, count);
  output(tool, { ...value, details: { changed: true } });
  assert.ok(accesses > count);
});

for (const name of ["bash", "codemode"]) for (const failed of [false, true]) {
  test(`native ${name} timer stops after expanded partial → collapsed ${failed ? "error" : "success"}`, (t) => {
    initTheme("dark", false);
    t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1000 });
    t.after(() => t.mock.timers.reset());
    const native = (name === "bash" ? createShellRenderers("$") : codemodeRenderers) as ToolRenderers;
    let updates = 0, invalidations = 0;
    const tool = setup({ ...native, renderResult(value, options, paint, ctx) {
      updates++; return native.renderResult!(value, options, paint, ctx);
    } })(name);
    const args = { command: "pwd", code: "text(1)" };
    const ctx = context({ expanded: true, isPartial: true, args, invalidate: () => { invalidations++; } });
    call(tool, args, ctx);
    output(tool, result("partial"), ctx);
    t.mock.timers.tick(1000);
    assert.equal(invalidations, 1, "native renderer started its redraw interval");
    output(tool, result("partial"), { ...ctx, expanded: false });
    const final = result(failed ? "failed" : "done");
    const done = { ...ctx, expanded: false, isPartial: false, isError: failed, durationMs: 0 };
    assert.match(plain(output(tool, final, done)), failed ? /failed/ : /1 line/);
    const terminalUpdates = updates;
    for (let i = 0; i < 10; i++) output(tool, { ...final }, done).render(80);
    assert.equal(updates, terminalUpdates, "hidden terminal delegate is not rebuilt on every redraw");
    t.mock.timers.tick(10_000);
    assert.equal(invalidations, 1, "completion reached the native timer even while collapsed");
  });
}

test("search context is labeled as lines; SDK trailers are not counted as files or entries", () => {
  const get = setup();
  assert.equal(plain(output(get("grep"), result("a.ts-1-before\na.ts:2:match\na.ts-3-after"))), "└ 3 lines");
  for (const [name, text, details, expected] of [
    ["find", "file.ts\n\n[1 results limit reached]", { resultLimitReached: 1 }, "1 file · limited"],
    ["ls", "file.ts\n\n[1 entries limit reached. Use limit=2 for more]", { entryLimitReached: 1 }, "1 entry · limited"],
    ["grep", "a.ts:1:match\n\n[1 matches limit reached]", { matchLimitReached: 1 }, "1 line · limited"],
    ["grep", "a.ts:1:long\n\n[Some lines truncated to 500 chars]", { linesTruncated: true }, "1 line · truncated"],
    ["find", "file.ts\n\n[50KB limit reached]", { truncation: { truncated: true } }, "1 file · truncated"],
    ["ls", "(empty directory)", undefined, "0 entries"],
  ] as const) assert.equal(plain(output(get(name), result(text, details))), `└ ${expected}`);
  assert.equal(plain(output(get("find"), result("a\n\n[filename]"))), "└ 3 files", "no trailer stripping without structured notice evidence");
});
