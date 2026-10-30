import assert from "node:assert/strict";
import test from "node:test";

import {
  MIN_NODE_VERSION,
  assertSupportedNodeVersion,
  isNodeVersionSupported,
} from "../scripts/lib.mjs";

test("Node version gate accepts 22.15+ and rejects older runtimes", () => {
  assert.equal(MIN_NODE_VERSION, "22.15");

  for (const version of ["20.0.0", "22.0.0", "22.14.0", "22.14.99"]) {
    assert.equal(isNodeVersionSupported(version), false, version);
    assert.throws(
      () => assertSupportedNodeVersion(version),
      { message: `Node >=22.15 is required; running ${version}.` },
      version,
    );
  }

  for (const version of ["22.15.0", "22.15.1", "22.99.0", "24.0.0", "v24.22.1"]) {
    assert.equal(isNodeVersionSupported(version), true, version);
    assert.doesNotThrow(() => assertSupportedNodeVersion(version), version);
  }
});
