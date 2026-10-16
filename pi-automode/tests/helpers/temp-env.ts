/**
 * Temp-directory environments for offline tests: an isolated agent dir and
 * workspace, never the real ~/.pi or any real project.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TempEnv extends Disposable {
	root: string;
	agentDir: string;
	workspace: string;
	writeAgentSettings: (settings: Record<string, unknown>) => void;
	cleanup: () => void;
}

export function createTempEnv(options?: { agentSettings?: Record<string, unknown> }): TempEnv {
	const root = mkdtempSync(join(tmpdir(), "pi-automode-test-"));
	const agentDir = join(root, "agent");
	const workspace = join(root, "workspace");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(workspace, { recursive: true });
	const env: TempEnv = {
		root,
		agentDir,
		workspace,
		writeAgentSettings(settings) {
			writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
		},
		cleanup() {
			rmSync(root, { recursive: true, force: true });
		},
		[Symbol.dispose]() {
			rmSync(root, { recursive: true, force: true });
		},
	};
	if (options?.agentSettings !== undefined) {
		env.writeAgentSettings(options.agentSettings);
	}
	return env;
}
