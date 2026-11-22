import assert from "node:assert/strict";
import test from "node:test";
import { checkedWheelScroll } from "../benchmarks/scroll/probe/index.ts";

test("busy wheel validation catches a stuck viewport even as the stream grows", () => {
  const errors: string[] = [];
  const view = { primary: true, isFollowingEnd: false, scrollTop: 1000, contentHeight: 1050, viewportHeight: 50,
    scrollBy(_lines: number) { return 0; } };
  view.contentHeight++;
  checkedWheelScroll(view, view.scrollBy, -1, message => errors.push(message));
  assert.deepEqual(errors, ["Wheel scroll of -1 lines from 1000 expected scrollTop 999, got 1000"]);
});

test("busy wheel validation allows clipping at the current follow-end boundary", () => {
  const view = { primary: true, isFollowingEnd: true, scrollTop: 1000, contentHeight: 1051, viewportHeight: 50,
    scrollBy(lines: number) { this.scrollTop = 1001; return lines; } };
  assert.equal(checkedWheelScroll(view, view.scrollBy, 1, message => assert.fail(message)), 1);
});
