/**
 * Child-process fixture for "host-smoke: default fatal policy fires on reload
 * gate failure (subprocess)".
 *
 * Creates a verified runtime with NO injected onFatal, then triggers a
 * reload-time gate provider construction failure. The launcher's default
 * fatal policy must print the "gate lost" notice to stderr and exit 1.
 * Fully offline: scripted fake provider, temp agent dir, temp workspace; no
 * secrets, no real models, no destructive markers.
 *
 * This file is plain .mjs: the test runner copies tests/fixtures into the
 * compiled test tree, so relative imports resolve against compiled output.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVerifiedRuntime } from "../../src/launcher.js";
import { createFakeProviderExtension, FAKE_MODEL_ID, FAKE_PROVIDER } from "../helpers/fake-provider.js";
import { createTestGateProvider } from "../helpers/test-gate.js";

const root = mkdtempSync(join(tmpdir(), "pi-automode-default-fatal-"));
const agentDir = join(root, "agent");
const workspace = join(root, "workspace");
mkdirSync(agentDir, { recursive: true });
mkdirSync(workspace, { recursive: true });
writeFileSync(
	join(agentDir, "settings.json"),
	JSON.stringify({ defaultProvider: FAKE_PROVIDER, defaultModel: FAKE_MODEL_ID }),
	{ mode: 0o600 },
);

const testGate = createTestGateProvider();
let generation = 0;
const { runtime } = await createVerifiedRuntime({
	cwd: workspace,
	agentDir,
	createAutomodeExtension: (options) => {
		generation += 1;
		if (generation === 2) throw new Error("inert provider construction failure");
		return testGate(options);
	},
	extraInlineExtensions: [createFakeProviderExtension([])],
	// Deliberately no onFatal: the default fatal policy must fire.
});
await runtime.session.bindExtensions({ onError: () => {} });
await runtime.session.reload();
// The default policy exits 1 via microtask. If it does not, fail loudly.
setTimeout(() => {
	console.error("default fatal policy did not fire");
	process.exit(42);
}, 10_000);
