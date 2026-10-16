#!/usr/bin/env node
/**
 * pi-automode launcher entry.
 *
 * `--help` and argument errors are handled without importing the gate or Pi
 * beyond the launcher module. Every other mode imports the real gate from
 * the package index (`dist/index.js`, source `src/index.ts`) and fails
 * closed if it cannot load.
 */
import { parseArgs, runLauncher } from "../dist/launcher.js";

const argv = process.argv.slice(2);
const parsed = parseArgs(argv);

if (parsed.kind === "help" || parsed.kind === "error") {
	process.exitCode = await runLauncher(argv, {
		createAutomodeExtension: () => {
			throw new Error("unreachable: help/usage never loads the gate");
		},
	});
} else {
	const { createAutomodeExtension } = await import("../dist/index.js");
	process.exitCode = await runLauncher(argv, { createAutomodeExtension });
}
