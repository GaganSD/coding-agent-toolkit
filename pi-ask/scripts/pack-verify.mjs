/**
 * pack:verify: assert the npm tarball carries the required published files
 * and no development trees. The repo CI has a generic pack check; this also
 * covers pi-ask's required docs, skill and screenshots.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

const REQUIRED = [
	"package.json",
	"src/index.ts",
	"skills/ask-user/SKILL.md",
	"README.md",
	"CHANGELOG.md",
	"LICENSE",
	"llms.txt",
	"assets/multi.png",
	"assets/single.png",
	"assets/text.png",
];

const FORBIDDEN = [/(^|\/)(node_modules|tests?|scripts|\.git|\.github|\.pi)(\/|$)/];

// Run npm through node, as ../scripts/lib.mjs does: Windows ships npm as a
// .cmd wrapper that execFileSync cannot start without a shell.
const packArgs = ["pack", "--dry-run", "--json"];
const [command, args] = process.env.npm_execpath
	? [process.execPath, [process.env.npm_execpath, ...packArgs]]
	: ["npm", packArgs];
const output = execFileSync(command, args, {
	shell: !process.env.npm_execpath && process.platform === "win32",
	cwd: root,
	encoding: "utf8",
	stdio: ["ignore", "pipe", "inherit"],
});
const first = Math.min(
	...["[", "{"].map((char) => output.indexOf(char)).filter((index) => index >= 0)
);
const last = Math.max(output.lastIndexOf("]"), output.lastIndexOf("}"));
const parsed = JSON.parse(output.slice(first, last + 1));
// npm <=11 prints an array; npm >=12 keys the same metadata by package name.
const entry = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
const files = entry.files.map((file) => file.path);
const set = new Set(files);
const missing = REQUIRED.filter((path) => !set.has(path));
const forbidden = files.filter((path) => FORBIDDEN.some((pattern) => pattern.test(path)));

if (missing.length > 0 || forbidden.length > 0) {
	if (missing.length > 0) {
		console.error(`pack:verify: missing from tarball:\n  ${missing.join("\n  ")}`);
	}
	if (forbidden.length > 0) {
		console.error(`pack:verify: forbidden files in tarball:\n  ${forbidden.join("\n  ")}`);
	}
	process.exit(1);
}
console.log(`pack:verify: ok (${files.length} files)`);
