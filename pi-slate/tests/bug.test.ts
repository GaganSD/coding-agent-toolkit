import assert from "node:assert/strict";
import test from "node:test";
import { openExternalArgs } from "../extensions/pi-slate/bug.ts";
import { SLATE_ISSUES_URL } from "../extensions/pi-slate/layout.ts";

test("bug link opens the GitHub issue tracker", () => {
  assert.equal(SLATE_ISSUES_URL, "https://github.com/GaganSD/coding-agent-toolkit/issues");
});

test("open args stay usable across platforms", () => {
  assert.deepEqual(openExternalArgs(SLATE_ISSUES_URL, "darwin"), { command: "open", args: [SLATE_ISSUES_URL] });
  assert.deepEqual(openExternalArgs(SLATE_ISSUES_URL, "linux"), { command: "xdg-open", args: [SLATE_ISSUES_URL] });
  assert.deepEqual(openExternalArgs(SLATE_ISSUES_URL, "win32"), { command: "cmd", args: ["/c", "start", "", `"${SLATE_ISSUES_URL}"`] });
  assert.deepEqual(openExternalArgs("/tmp/note.md", "darwin"), { command: "open", args: ["/tmp/note.md"] });
  assert.deepEqual(openExternalArgs("/tmp/note.md", "linux"), { command: "xdg-open", args: ["/tmp/note.md"] });
  assert.deepEqual(openExternalArgs("/tmp/note.md", "win32"), { command: "cmd", args: ["/c", "start", "", `"/tmp/note.md"`] });
});
