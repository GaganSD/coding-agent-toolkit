import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GitBranchPoller } from "../extensions/pi-slate/git-branch.ts";

test("editor branch service polls independently and stops on disposal", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const calls: string[][] = [];
  const branches: Array<string | null> = [];
  const pi = { exec: async (_command: string, args: string[]) => {
    calls.push(args);
    return { code: 0, stdout: calls.length <= 2 ? "feature\n" : "\n", stderr: "", killed: false };
  } } as Pick<ExtensionAPI, "exec">;
  const poller = new GitBranchPoller(pi, branch => { branches.push(branch); });
  t.after(() => poller.dispose());
  poller.start("/workspace");
  await Promise.resolve();
  assert.deepEqual(calls, [["-C", "/workspace", "branch", "--show-current"]]);
  assert.deepEqual(branches, ["feature"]);
  t.mock.timers.tick(5000);
  await Promise.resolve();
  assert.deepEqual(branches, ["feature"], "unchanged labels do not repaint");
  t.mock.timers.tick(5000);
  await Promise.resolve();
  assert.deepEqual(branches, ["feature", null]);
  t.mock.timers.tick(5000);
  await Promise.resolve();
  assert.deepEqual(branches, ["feature", null], "a missing branch is also deduplicated");
  poller.dispose();
  poller.dispose();
  t.mock.timers.tick(10_000);
  assert.equal(calls.length, 4);
});

test("a throwing repaint callback does not reject the background poll", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let branch = "first";
  const branches: string[] = [];
  const pi = { exec: async () => ({ code: 0, stdout: branch, stderr: "", killed: false }) } as Pick<ExtensionAPI, "exec">;
  const poller = new GitBranchPoller(pi, next => { branches.push(next!); if (next === "first") throw new Error("stale UI"); });
  t.after(() => poller.dispose());
  poller.start("/workspace");
  await Promise.resolve();
  branch = "second";
  t.mock.timers.tick(5000);
  await Promise.resolve();
  assert.deepEqual(branches, ["first", "second"]);
});

test("replacement can poll immediately and a stale branch cannot repaint", async (t) => {
  type Result = { code: number; stdout: string; stderr: string; killed: boolean };
  const finish: Array<(result: Result) => void> = [];
  const pi = { exec: () => new Promise<Result>(resolve => finish.push(resolve)) } as Pick<ExtensionAPI, "exec">;
  const branches: Array<string | null> = [];
  const poller = new GitBranchPoller(pi, branch => { branches.push(branch); });
  t.after(() => poller.dispose());
  poller.start("/workspace");
  poller.start("/replacement");
  assert.equal(finish.length, 2);
  finish[1]!({ code: 0, stdout: "current", stderr: "", killed: false });
  finish[0]!({ code: 0, stdout: "stale", stderr: "", killed: false });
  await Promise.resolve();
  assert.deepEqual(branches, ["current"]);
});
