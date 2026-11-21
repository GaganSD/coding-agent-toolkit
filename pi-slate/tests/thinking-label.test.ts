import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { AssistantMessageComponent, initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { ThinkingFoldTracker } from "../extensions/pi-slate/thinking-fold.ts";
import {
  decorateThinkingRows,
  HIDDEN_THINKING_LABEL,
  replaceHiddenThinkingRows,
  STREAMING_THINKING_LABEL,
  ThinkingDurations,
  thinkingLabel,
  type ThinkingView,
} from "../extensions/pi-slate/thinking-label.ts";
import { ChatSurface } from "../extensions/pi-slate/chat-surface.ts";
import { ToolGroups } from "../extensions/pi-slate/tool-groups.ts";
import { theme as hostTheme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

const thinking = (value: string) => ({ type: "thinking" as const, thinking: value });
const text = (value: string) => ({ type: "text" as const, text: value });
const call = (id: string) => ({ type: "toolCall" as const, id, name: "bash", arguments: {} });
const theme = { fg: (_: string, value: string) => value, bold: (value: string) => value } as Theme;
const labelTheme = {
  fg(color: string, value: string) { return color === "thinkingText" ? `\x1b[38;5;109m${value}\x1b[39m` : value; },
  italic(value: string) { return `\x1b[3m${value}\x1b[23m`; },
};
const styledThinking = (label: string) => labelTheme.italic(labelTheme.fg("thinkingText", label));
const padRow = (row: string, width = 60) => row + " ".repeat(Math.max(0, width - visibleWidth(row)));
const hostStyledLabel = () => hostTheme.italic(hostTheme.fg("thinkingText", HIDDEN_THINKING_LABEL));

function durationsFixture() {
  let now = 0;
  const durations = new ThinkingDurations();
  const tracker = new ThinkingFoldTracker({
    now: () => now,
    schedule: () => () => {},
    onComplete: ({ thinking, elapsedMs }) => durations.record(thinking, elapsedMs),
  });
  return {
    durations,
    tracker,
    advance(ms: number) { now += ms; },
    decorate(component: unknown, rows: readonly string[]) {
      return decorateThinkingRows(component as ThinkingView, rows, {
        active: tracker.active(),
        durations,
        styledLabel: hostStyledLabel(),
      });
    },
    version: () => `${durations.version}:${tracker.revision}`,
  };
}

test("collapsed labels cover streaming, observed durations, and restored runs", () => {
  assert.equal(thinkingLabel({ streaming: true }), STREAMING_THINKING_LABEL);
  assert.equal(thinkingLabel({ streaming: false, durationMs: 12_400 }), "Thought for 12s");
  assert.equal(thinkingLabel({ streaming: false, durationMs: 999 }), "Thought for 1s");
  assert.equal(thinkingLabel({ streaming: false, durationMs: 2_000 }), "Thought for 2s");
  assert.equal(thinkingLabel({ streaming: false, durationMs: Number.NaN }), "Thought");
  assert.equal(thinkingLabel({ streaming: false }), "Thought");
});

test("duration memory is bounded, cleared, and versioned", () => {
  const durations = new ThinkingDurations(2);
  const initial = durations.version;
  durations.record("one", 1_000);
  durations.record("two", 2_000);
  durations.record("one", 3_000);
  durations.record("three", 4_000);
  assert.equal(durations.lookup("one"), 3_000);
  assert.equal(durations.lookup("two"), undefined);
  assert.equal(durations.lookup("three"), 4_000);
  assert.ok(durations.version > initial);
  const recorded = durations.version;
  durations.clear();
  assert.equal(durations.lookup("one"), undefined);
  assert.equal(durations.lookup("three"), undefined);
  assert.ok(durations.version > recorded);
});

test("row replacement keeps Pi's styling and row width, and returns the input when unchanged", () => {
  const styled = styledThinking(HIDDEN_THINKING_LABEL);
  const rows = ["", ` ${styled}`, " answer", ` ${styled}`].map((row) => padRow(row));
  const view: ThinkingView = {
    lastMessage: { content: [thinking("first run"), text("answer"), thinking("second run")] },
    hideThinkingBlock: true,
  };
  const durations = new ThinkingDurations();
  durations.record("first run", 12_000);
  const decorated = decorateThinkingRows(view, rows, { active: null, durations, styledLabel: styled });
  assert.deepEqual(decorated.map((row) => stripVTControlCharacters(row).trimEnd()), [
    "", " Thought for 12s", " answer", " Thought",
  ]);
  const original = rows.find((row) => stripVTControlCharacters(row).trim() === HIDDEN_THINKING_LABEL)!;
  const changed = decorated.find((row) => stripVTControlCharacters(row).includes("Thought for 12s"))!;
  assert.equal(changed.slice(0, changed.indexOf("Thought")), original.slice(0, original.indexOf("Thought")));
  assert.equal(visibleWidth(changed), visibleWidth(original));
  assert.equal(decorateThinkingRows(view, rows, {
    active: null,
    durations: new ThinkingDurations(),
    styledLabel: styled,
  }), rows);
});

test("the chat surface paints a live run, then its observed duration, and the row still toggles", (t) => {
  initTheme("dark", false);
  const f = durationsFixture();
  const message = { role: "assistant", stopReason: "toolUse", content: [thinking("first run"), call("a")] };
  const assistant = new AssistantMessageComponent(message as never, true, undefined, HIDDEN_THINKING_LABEL);
  const chat = new Container();
  chat.addChild(assistant);
  const surface = new ChatSurface(chat, { decorate: (component, rows) => f.decorate(component, rows) });
  t.after(() => surface.dispose());
  const rows = () => chat.render(60).map((row) => stripVTControlCharacters(row).trimEnd());

  f.tracker.observe({ type: "thinking_start", contentIndex: 0 }, message);
  assert.ok(rows().some((row) => row.includes(STREAMING_THINKING_LABEL)), rows().join("\n"));
  f.advance(4_000);
  f.tracker.observe({ type: "thinking_end", contentIndex: 0 }, message);
  const completed = rows();
  assert.ok(completed.some((row) => row.includes("Thought for 4s")), completed.join("\n"));

  const y = completed.findIndex((row) => row.includes("Thought for 4s"));
  assert.equal(chat.handleMouse({
    type: "click", button: "left", x: 3, y, screenX: 3, screenY: y,
    width: 60, height: completed.length, shift: false, alt: false, ctrl: false,
  } as TuiMouseEvent)?.handled, true);
  assert.ok(rows().some((row) => row.includes("first run")), rows().join("\n"));
  assert.ok(!rows().some((row) => row.includes("Thought for 4s")), "expanded thinking leaves the collapsed label");
});

test("a grouped live run updates its cached row to the observed duration and still toggles", () => {
  initTheme("dark", false);
  const f = durationsFixture();
  const message = { role: "assistant", stopReason: "toolUse", content: [thinking("live run"), call("a"), call("b")] };
  const assistant = new AssistantMessageComponent(message as never, true, undefined, HIDDEN_THINKING_LABEL);
  const tool = (id: string) => ({
    toolCallId: id, toolName: "bash", expanded: false, isPartial: false,
    result: { isError: false, content: [] as Array<{ type: string }> },
    render() { return ["", "✓ Bash (pwd)"]; },
    invalidate() {}, setExpanded(value: boolean) { this.expanded = value; },
  });
  const children = [assistant, tool("a"), tool("b")];
  const groups = new ToolGroups(
    () => theme,
    () => "expand",
    (component, rows) => f.decorate(component, rows),
    f.version,
  );
  const rows = () => groups.render(children, 80).map((row) => stripVTControlCharacters(row));

  f.tracker.observe({ type: "thinking_start", contentIndex: 0 }, message);
  assert.match(rows().join("\n"), /Done \(2 tool calls\)[\s\S]*Thinking…/);
  f.advance(3_000);
  f.tracker.observe({ type: "thinking_end", contentIndex: 0 }, message);
  const completed = rows();
  assert.match(completed.join("\n"), /Done \(2 tool calls\)[\s\S]*Thought for 3s/);

  const y = completed.findIndex((row) => row.includes("Thought for 3s"));
  assert.equal(groups.handleMouse({
    type: "click", button: "left", x: 5, y, screenX: 8, screenY: y + 4,
    width: 80, height: completed.length, shift: false, alt: false, ctrl: false,
  } as TuiMouseEvent)?.handled, true);
  assert.match(rows().join("\n"), /live run/);
  assert.doesNotMatch(rows().join("\n"), /Thought for 3s/);
});

test("group frames reuse decorated rows until the label key changes", () => {
  initTheme("dark", false);
  const f = durationsFixture();
  const message = { role: "assistant", stopReason: "toolUse", content: [thinking("cached run"), call("a")] };
  const assistant = new AssistantMessageComponent(message as never, true, undefined, HIDDEN_THINKING_LABEL);
  const other = { render: () => ["", "✓ Bash (pwd)"], invalidate() {} };
  const children = [assistant, other];
  let decorations = 0;
  const groups = new ToolGroups(
    () => undefined,
    () => "expand",
    (component, rows) => { decorations++; return f.decorate(component, rows); },
    f.version,
  );

  const first = groups.render(children, 80);
  const painted = decorations;
  assert.equal(groups.render(children, 80), first);
  assert.equal(decorations, painted, "an unchanged frame reuses decorated rows");

  f.tracker.observe({ type: "thinking_start", contentIndex: 0 }, message);
  const streaming = groups.render(children, 80);
  assert.notEqual(streaming, first);
  assert.ok(decorations > painted);
  const repainted = decorations;
  assert.equal(groups.render(children, 80), streaming);
  assert.equal(decorations, repainted);
});


test("a stopped run without thinking_end clears the cached streaming label", () => {
  initTheme("dark", false);
  const f = durationsFixture();
  const message = { role: "assistant", stopReason: "toolUse", content: [thinking("stopped run")] };
  const assistant = new AssistantMessageComponent(message as never, true, undefined, HIDDEN_THINKING_LABEL);
  const groups = new ToolGroups(
    () => undefined,
    () => "expand",
    (component, rows) => f.decorate(component, rows),
    f.version,
  );
  const rows = () => groups.render([assistant], 80).map((row) => stripVTControlCharacters(row)).join("\n");

  f.tracker.observe({ type: "thinking_start", contentIndex: 0 }, message);
  assert.match(rows(), /Thinking…/);
  f.tracker.stop();
  assert.match(rows(), /Thought/);
  assert.doesNotMatch(rows(), /Thinking…/);
});

test("an answer line named Thought is not treated as the hidden row", () => {
  const styled = styledThinking(HIDDEN_THINKING_LABEL);
  const rows = ["", ` ${HIDDEN_THINKING_LABEL}`, ` ${styled}`].map((row) => padRow(row));
  const view: ThinkingView = {
    lastMessage: { content: [text("Thought"), thinking("hidden run")] },
    hideThinkingBlock: true,
  };
  const durations = new ThinkingDurations();
  durations.record("hidden run", 5_000);
  const expected = ["", " Thought", " Thought for 5s"];
  const decorated = decorateThinkingRows(view, rows, { active: null, durations, styledLabel: styled })
    .map((row) => stripVTControlCharacters(row).trimEnd());
  assert.deepEqual(decorated, expected);
  assert.deepEqual(replaceHiddenThinkingRows(rows, ["Thought for 5s"], styled)
    .map((row) => stripVTControlCharacters(row).trimEnd()), expected);
});

test("only the streaming message shows Thinking…", () => {
  initTheme("dark", false);
  const f = durationsFixture();
  const older = { role: "assistant", stopReason: "toolUse", content: [thinking("older run"), call("a")] };
  const newer = { role: "assistant", stopReason: "toolUse", content: [thinking("new run"), call("b")] };
  const olderComponent = new AssistantMessageComponent(older as never, true, undefined, HIDDEN_THINKING_LABEL);
  const newerComponent = new AssistantMessageComponent(newer as never, true, undefined, HIDDEN_THINKING_LABEL);

  f.tracker.observe({ type: "thinking_start", contentIndex: 0 }, older);
  f.advance(2_000);
  f.tracker.observe({ type: "thinking_end", contentIndex: 0 }, older);
  f.tracker.observe({ type: "thinking_start", contentIndex: 0 }, newer);

  const paint = (component: AssistantMessageComponent) =>
    f.decorate(component, component.render(60)).map((row) => stripVTControlCharacters(row)).join("\n");
  assert.match(paint(olderComponent), /Thought for 2s/);
  assert.doesNotMatch(paint(olderComponent), /Thinking…/);
  assert.match(paint(newerComponent), /Thinking…/);
});
