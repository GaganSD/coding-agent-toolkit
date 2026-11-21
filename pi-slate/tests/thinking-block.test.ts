import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { AssistantMessageComponent, initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, visibleWidth, type MarkdownTheme, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { ThinkingFoldTracker } from "../extensions/pi-slate/thinking-fold.ts";
import {
  createThinkingPalette,
  formatThinkingHeader,
  hiddenThinkingRuns,
  renderThinkingBlock,
  replaceHiddenThinkingRows,
  THINKING_FALLBACK_LABEL,
  thinkingRunText,
  thinkingWordCount,
  ThinkingDurations,
  type ThinkingTheme,
} from "../extensions/pi-slate/thinking-block.ts";
import { ChatSurface } from "../extensions/pi-slate/chat-surface.ts";
import { ToolGroups } from "../extensions/pi-slate/tool-groups.ts";

const colors: Record<string, string> = {
  dim: "\x1b[38;5;240m",
  muted: "\x1b[38;5;244m",
  thinkingText: "\x1b[38;5;250m",
};

const fakeTheme: ThinkingTheme = {
  fg(color, text) {
    const code = colors[color];
    return code ? `${code}${text}\x1b[39m` : text;
  },
  italic: (text) => `\x1b[3m${text}\x1b[23m`,
};

const markdownTheme: MarkdownTheme = {
  heading: (text) => text, link: (text) => text, linkUrl: (text) => text,
  code: (text) => text, codeBlock: (text) => text, codeBlockBorder: (text) => text,
  quote: (text) => text, quoteBorder: (text) => text, hr: (text) => text,
  listBullet: (text) => text, bold: (text) => text, italic: (text) => text,
  strikethrough: (text) => text, underline: (text) => text,
};

function renderMarkdown(markdown: string, width: number): string[] {
  const palette = createThinkingPalette(fakeTheme);
  const transformed = renderThinkingBlock(markdown, {
    palette,
    header: formatThinkingHeader({ durationMs: 12_000, expanded: true }),
    availableWidth: width,
  });
  const component = new Markdown(transformed, 0, 0, markdownTheme, {
    color: (text) => fakeTheme.fg("thinkingText", text),
    italic: true,
  });
  return component.render(width).map((line) => stripVTControlCharacters(line).trimEnd());
}

const thinking = (value: string) => ({ type: "thinking" as const, thinking: value });
const text = (value: string) => ({ type: "text" as const, text: value });
const call = (id: string) => ({ type: "toolCall" as const, id, name: "bash", arguments: {} });

test("headers cover live, done, unknown words, short durations, and chevrons", () => {
  assert.equal(formatThinkingHeader({ streaming: true, elapsedMs: 7_000, expanded: false }), "∴ Thinking 7s ›");
  assert.equal(formatThinkingHeader({ streaming: true, elapsedMs: 999, expanded: true }), "∴ Thinking ⌄");
  assert.equal(formatThinkingHeader({ durationMs: 12_000, expanded: false }), "∴ Thought for 12s ›");
  assert.equal(formatThinkingHeader({ durationMs: 12_000, expanded: true }), "∴ Thought for 12s ⌄");
  assert.equal(formatThinkingHeader({ durationMs: 0, expanded: false }), "∴ Thought for 1s ›");
  assert.equal(formatThinkingHeader({ durationMs: 999, expanded: false }), "∴ Thought for 1s ›");
  assert.equal(formatThinkingHeader({ durationMs: 1_000, expanded: false }), "∴ Thought for 1s ›");
  assert.equal(formatThinkingHeader({ durationMs: 1_999, expanded: false }), "∴ Thought for 1s ›");
  assert.equal(formatThinkingHeader({ durationMs: 2_000, expanded: false }), "∴ Thought for 2s ›");
  assert.equal(formatThinkingHeader({ words: 320, expanded: false }), "∴ Thought · 320 words ›");
  assert.equal(formatThinkingHeader({ words: 1, expanded: false }), "∴ Thought · 1 word ›");
  assert.equal(formatThinkingHeader({ words: 0, expanded: false }), "∴ Thought ›");
  assert.equal(formatThinkingHeader({ durationMs: NaN, words: 3, expanded: false }), "∴ Thought · 3 words ›");
  assert.equal(thinkingWordCount("  one two\nthree  "), 3);
  assert.equal(thinkingWordCount(""), 0);
});

test("collapsed per-run header keeps Pi's indent at width 60", () => {
  const palette = createThinkingPalette(fakeTheme);
  const row = ` ${THINKING_FALLBACK_LABEL}${" ".repeat(60 - 1 - visibleWidth(THINKING_FALLBACK_LABEL))}`;
  const header = palette.header(formatThinkingHeader({ durationMs: 12_000, expanded: false }));
  const output = replaceHiddenThinkingRows([row], [header]).map((line) => stripVTControlCharacters(line).trimEnd());
  assert.deepEqual(output, [" ∴ Thought for 12s ›"]);
});

test("live durations are recorded at thinking_end for a full consecutive run", () => {
  let now = 0;
  const durations = new ThinkingDurations();
  const tracker = new ThinkingFoldTracker({
    now: () => now,
    schedule: () => () => {},
    onComplete: ({ thinking, elapsedMs }) => durations.record(thinking, elapsedMs),
  });
  const message = { content: [thinking("first thought"), thinking("second thought")] };
  tracker.observe({ type: "thinking_start", contentIndex: 0 }, message);
  now = 12_400;
  assert.equal(tracker.activeContentIndex(), 0);
  tracker.observe({ type: "thinking_end", contentIndex: 0 }, message);
  assert.equal(tracker.activeContentIndex(), null);
  assert.equal(durations.lookup("first thought\n\nsecond thought"), 12_400);
  assert.equal(durations.lookup("first thought"), undefined);
  assert.equal(thinkingRunText(message.content, 0), "first thought\n\nsecond thought");
  assert.equal(thinkingRunText(message.content, 1), "first thought\n\nsecond thought");
  assert.equal(thinkingRunText([text("answer")], 0), "");

  durations.record("short", 250);
  durations.record("negative", -1);
  durations.record("", 1000);
  assert.equal(durations.size, 2);
  durations.clear();
  assert.equal(durations.lookup("short"), undefined);
});

test("adjacent thinking blocks accumulate one run duration across starts and ends", () => {
  let now = 0;
  const durations = new ThinkingDurations();
  const tracker = new ThinkingFoldTracker({
    now: () => now,
    schedule: () => () => {},
    onComplete: ({ thinking, elapsedMs }) => durations.record(thinking, elapsedMs),
  });
  const message = { content: [thinking("first"), thinking("second")] };
  tracker.observe({ type: "thinking_start", contentIndex: 0 }, message);
  now = 3_000;
  tracker.observe({ type: "thinking_end", contentIndex: 0 }, message);
  tracker.observe({ type: "thinking_start", contentIndex: 1 }, message);
  now = 5_000;
  tracker.observe({ type: "thinking_end", contentIndex: 1 }, message);
  assert.equal(durations.lookup("first\n\nsecond"), 5_000);
  assert.equal(tracker.elapsedMs(), null);
  tracker.dispose();
});

test("duration memory is bounded and refreshes an existing key", () => {
  const durations = new ThinkingDurations(2);
  durations.record("one", 1000);
  durations.record("two", 2000);
  durations.record("one", 3000);
  durations.record("three", 4000);
  assert.equal(durations.size, 2);
  assert.equal(durations.lookup("one"), 3000);
  assert.equal(durations.lookup("two"), undefined);
  assert.equal(durations.lookup("three"), 4000);
});

test("expanded thinking renders the header, rail, and Pi's italic thinking style at width 60", () => {
  const lines = renderMarkdown([
    "The error mentions a NOT NULL constraint on orders.region. The migration adds that",
    "column without a default, so any row from before the March import would fail.",
  ].join(" "), 60);
  assert.deepEqual(lines, [
    "∴ Thought for 12s ⌄",
    "│ The error mentions a NOT NULL constraint on orders.region.",
    "│ The migration adds that column without a default, so any",
    "│ row from before the March import would fail.",
  ]);
  for (const line of lines.slice(1)) {
    assert.ok(line.startsWith("│ "), line);
    assert.ok(visibleWidth(line) <= 60, line);
  }
});

test("every wrapped body row carries a rail at narrow widths, including blank and long words", () => {
  const lines = renderMarkdown(`supercalifragilisticexpialidocious0123456789\n\nshort line`, 20);
  assert.ok(lines[0]!.startsWith("∴ Thought for 12s"), lines[0]);
  for (const line of lines.slice(1)) {
    assert.ok(line.startsWith("│"), line);
    assert.ok(visibleWidth(line) <= 20, line);
  }
  assert.ok(lines.some((line) => line.trim() === "│"), "blank thinking lines keep the rail");
  assert.ok(lines.length > 4, "the long word is hard-wrapped");
});

test("fenced code inside thinking stays inside the rail on every row", () => {
  const lines = renderMarkdown("```ts\nconst value = 1;\nconsole.log(value);\n```", 40);
  assert.equal(lines[0], "∴ Thought for 12s ⌄");
  const body = lines.slice(1);
  assert.ok(body.length >= 4, body.join("\n"));
  for (const line of body) assert.ok(line.startsWith("│ "), line);
  assert.match(body.join("\n"), /const value = 1;/);
  assert.match(body.join("\n"), /console\.log\(value\);/);
});

test("empty thinking produces no header or rail", () => {
  const palette = createThinkingPalette(fakeTheme);
  assert.equal(renderThinkingBlock("", { palette, header: "∴ Thought ⌄", availableWidth: 40 }), "");
  assert.equal(renderThinkingBlock("  \n\t ", { palette, header: "∴ Thought ⌄", availableWidth: 40 }), "");
});

test("the rail reset reopens thinkingText and italic for the body", () => {
  const palette = createThinkingPalette(fakeTheme);
  const output = renderThinkingBlock("body text", {
    palette,
    header: "∴ Thought for 2s ⌄",
    availableWidth: 40,
  });
  const body = output.split("\n")[1]!;
  assert.ok(body.includes(`${palette.rail("│")} ${palette.thinkingReopen}body text`), "thinkingText + italic reopen after the dim rail");
  assert.ok(palette.thinkingReopen.includes(colors.thinkingText!));
  assert.ok(palette.thinkingReopen.includes("\x1b[3m"));
  assert.ok(output.startsWith("\x1b[23m"), "the header cancels Pi's default italic");
});

test("hidden rows map per run, in order, and multiple runs in one message stay distinct", () => {
  const view = {
    lastMessage: {
      content: [
        thinking("first run"),
        thinking("same run"),
        text("answer"),
        thinking("second run"),
        call("a"),
        thinking("third run"),
      ],
    },
    hideThinkingBlock: true,
  };
  assert.deepEqual(hiddenThinkingRuns(view).map((run) => run.thinking), [
    "first run\n\nsame run", "second run", "third run",
  ]);
  assert.deepEqual(hiddenThinkingRuns(view).map((run) => [run.index, run.start, run.end]), [
    [0, 0, 1], [1, 3, 3], [2, 5, 5],
  ]);

  const rows = [
    "  \x1b[3m∴ Thought ›\x1b[23m  ",
    "answer",
    "  ∴ Thought ›  ",
    "tool row",
    "  ∴ Thought ›  ",
  ];
  const headers = ["H1", "H2", "H3"];
  const replaced = replaceHiddenThinkingRows(rows, headers).map((row) => stripVTControlCharacters(row).trimEnd());
  assert.deepEqual(replaced, ["  H1", "answer", "  H2", "tool row", "  H3"]);
  assert.deepEqual(replaceHiddenThinkingRows(rows, ["H1"]).map((row) => stripVTControlCharacters(row).trimEnd()), [
    "  H1", "answer", "  ∴ Thought ›", "tool row", "  ∴ Thought ›",
  ]);

  const overrides = new Map<number, boolean>([[0, false], [1, true]]);
  assert.deepEqual(hiddenThinkingRuns({ ...view, thinkingVisibilityOverrides: overrides }).map((run) => run.thinking), [
    "second run", "third run",
  ]);
});

test("existing tests still expect Pi's static hidden label with no decorator", () => {
  initTheme("dark", false);
  const component = new AssistantMessageComponent({
    role: "assistant", stopReason: "toolUse",
    content: [thinking("reasoning"), call("a")],
  } as never, true);
  const rows = component.render(60).map(stripVTControlCharacters);
  assert.ok(rows.some((row) => row.includes("Thinking...")));
});

test("per-run hidden headers replace static labels inside grouped tool trees", () => {
  initTheme("dark", false);
  const durations = new ThinkingDurations();
  durations.record("first run", 3_000);
  durations.record("second run", 5_000);
  const palette = createThinkingPalette(fakeTheme);
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;

  const assistant = new AssistantMessageComponent({
    role: "assistant", stopReason: "toolUse",
    content: [thinking("first run"), call("a"), thinking("second run"), call("b")],
  } as never, true, undefined, THINKING_FALLBACK_LABEL);
  const tool = (id: string) => ({
    toolCallId: id, toolName: "bash", expanded: false, isPartial: false,
    result: { isError: false, content: [] as Array<{ type: string }> },
    render(width: number) { return ["", "✓ Bash (pwd)".slice(0, width)]; },
    invalidate() {}, setExpanded() {},
  });
  const decorate = (component: Parameters<ToolGroups["render"]>[0][number], rows: readonly string[]) => {
    const hidden = hiddenThinkingRuns(component as never);
    if (!hidden.length) return rows;
    return replaceHiddenThinkingRows(rows, hidden.map((run) => palette.header(formatThinkingHeader({
      durationMs: durations.lookup(run.thinking),
      words: thinkingWordCount(run.thinking),
      expanded: false,
    }))), THINKING_FALLBACK_LABEL);
  };
  const groups = new ToolGroups(() => theme, () => "expand", decorate);
  const rows = groups.render([assistant, tool("a"), tool("b")], 80).map(stripVTControlCharacters);
  const output = rows.join("\n");
  assert.match(output, /Done \(2 tool calls\)/);
  assert.match(output, /│ {3}∴ Thought for 3s ›/);
  assert.match(output, /│ {3}∴ Thought for 5s ›/);
  assert.doesNotMatch(output, /∴ Thought ›/);
  assert.ok(rows.every((row) => visibleWidth(row) <= 80));

  const headerY = rows.findIndex((row) => row.includes("Thought for 3s"));
  const click = groups.handleMouse({
    type: "click", button: "left", x: 5, y: headerY, screenX: 8, screenY: headerY + 4,
    width: 80, height: rows.length, shift: false, alt: false, ctrl: false,
  } as TuiMouseEvent);
  assert.equal(click?.handled, true);
  const opened = groups.render([assistant, tool("a"), tool("b")], 80).map(stripVTControlCharacters).join("\n");
  assert.match(opened, /first run/);
  assert.doesNotMatch(opened, /first run[\s\S]*second run/, "only the clicked run opens");
});

test("the chat surface decorates native hidden rows and the native row still toggles", () => {
  initTheme("dark", false);
  const durations = new ThinkingDurations();
  durations.record("first run", 4_000);
  const palette = createThinkingPalette(fakeTheme);
  const assistant = new AssistantMessageComponent({
    role: "assistant", stopReason: "toolUse",
    content: [thinking("first run"), call("a")],
  } as never, true, undefined, THINKING_FALLBACK_LABEL);
  const chat = new Container();
  chat.addChild(assistant);
  const surface = new ChatSurface(chat, {
    decorate(component, rows) {
      const hidden = hiddenThinkingRuns(component as never);
      if (!hidden.length) return rows;
      return replaceHiddenThinkingRows(rows, hidden.map((run) => palette.header(formatThinkingHeader({
        durationMs: durations.lookup(run.thinking),
        expanded: false,
      }))), THINKING_FALLBACK_LABEL);
    },
  });
  const rows = () => chat.render(60).map((row) => stripVTControlCharacters(row).trimEnd());
  assert.ok(rows().some((row) => row.includes("∴ Thought for 4s ›")), rows().join("\n"));
  const y = rows().findIndex((row) => row.includes("Thought for 4s"));
  assert.equal(chat.handleMouse({
    type: "click", button: "left", x: 3, y, screenX: 3, screenY: y,
    width: 60, height: rows().length, shift: false, alt: false, ctrl: false,
  } as TuiMouseEvent)?.handled, true);
  assert.ok(rows().some((row) => row.includes("first run")), rows().join("\n"));
  assert.ok(!rows().some((row) => row.includes("Thought for 4s")), "expanded run leaves the collapsed header");
  surface.dispose();
});

test("a decorator can paint a hidden row while chat ownership keeps native clicks", () => {
  initTheme("dark", false);
  const durations = new ThinkingDurations();
  durations.record("first run", 4_000);
  const palette = createThinkingPalette(fakeTheme);
  const assistant = new AssistantMessageComponent({
    role: "assistant", stopReason: "toolUse",
    content: [thinking("first run"), call("a")],
  } as never, true, undefined, THINKING_FALLBACK_LABEL);
  const tool = {
    toolCallId: "a", toolName: "bash", expanded: false, isPartial: false,
    result: { isError: false, content: [] as Array<{ type: string }> },
    render() { return ["", "✓ Bash (pwd)"]; },
    invalidate() {}, setExpanded() {},
  };
  const decorate = (component: Parameters<ToolGroups["render"]>[0][number], rows: readonly string[]) => {
    const hidden = hiddenThinkingRuns(component as never);
    if (!hidden.length) return rows;
    return replaceHiddenThinkingRows(rows, hidden.map((run) => palette.header(formatThinkingHeader({
      durationMs: durations.lookup(run.thinking),
      expanded: false,
    }))), THINKING_FALLBACK_LABEL);
  };
  const groups = new ToolGroups(() => undefined, () => "expand", decorate);
  const children = [assistant, tool];
  const rows = groups.render(children, 80).map(stripVTControlCharacters);
  assert.match(rows.join("\n"), /∴ Thought for 4s ›/);
  // One tool never groups; the native assistant row keeps its owner and is rendered once.
  assert.equal(rows.filter((row) => row.includes("Thought for 4s")).length, 1);
  assert.ok(children[0] instanceof AssistantMessageComponent);
  const container = new Container();
  container.addChild(assistant); container.addChild(tool);
  assert.equal(container.children.length, 2);
});
