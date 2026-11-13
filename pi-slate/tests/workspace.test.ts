import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { detectCapabilities, getCapabilities, setCapabilities } from "@earendil-works/pi-tui";
import { ImageWorkspaceView } from "../extensions/pi-slate/workspace.ts";

const theme = { fg: (_color: string, text: string) => text } as Theme;
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";

test("Pi 1.4 Rex capabilities reach Slate's image workspace without terminal-specific overrides", t => {
  const capabilities = getCapabilities();
  const keys = ["TERM_PROGRAM", "TERM", "TMUX", "PI_IMAGE_PROTOCOL", "PI_TRUE_COLOR", "PI_HYPERLINKS"];
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    setCapabilities(capabilities);
  });
  for (const key of keys) delete process.env[key];
  process.env.TERM_PROGRAM = "rex"; process.env.TERM = "xterm-256color";
  const rex = detectCapabilities(() => { assert.fail("Rex detection must not probe tmux"); });
  assert.deepEqual(rex, { images: "kitty", trueColor: true, hyperlinks: true });
  setCapabilities(rex);
  const view = new ImageWorkspaceView("1", "/tmp/image.png", { type: "image", data: png, mimeType: "image/png" }, theme);
  const lines = view.render(30, 10);
  assert(lines.some(line => line.includes("\x1b_G")), "use Pi's Kitty image rendering rather than a text placeholder");
  assert.equal(lines.length, 10);
  assert.equal(view.render(30, 10), lines, "unchanged image frames remain cached");
  setCapabilities({ ...rex, images: null }); view.invalidate();
  const fallback = view.render(30, 10);
  assert(fallback.every(line => !line.includes("\x1b_G")));
  assert.match(fallback.join("\n"), /\[Image:/);
});
