/**
 * pack-check: verify the npm tarball contents are exactly the shippable set.
 * Fails (exit 1) when unexpected files would ship or expected files are missing.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const REQUIRED = [
	"package.json",
	"README.md",
	"CHANGELOG.md",
	"LICENSE",
	"bin/pi-automode.js",
	"dist/index.js",
	"dist/launcher.js",
	"docs/launcher.md",
	"docs/specification.md",
];

// Paths that must never ship.
const FORBIDDEN_PATTERNS = [
	/^tests\//,
	/^src\//,
	/^scripts\//,
	/^node_modules\//,
	/tsconfig/,
	/\.map$/, // source maps would be broken refs: src/ is not shipped
	/^ux-mockups\.html$/,
	/^IMPLEMENTATION\.md$/,
];

const output = execFileSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8" });
const first = Math.min(...["[", "{"].map((c) => output.indexOf(c)).filter((i) => i >= 0));
const last = Math.max(output.lastIndexOf("]"), output.lastIndexOf("}"));
const parsed = JSON.parse(output.slice(first, last + 1));
// npm <=11 prints an array; npm >=12 prints an object keyed by package name.
const entry = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
const files = entry.files.map((f) => f.path);
const set = new Set(files);

// The pi.extensions manifest must point at a shipped dist entry.
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const declared = pkg.pi?.extensions ?? [];
for (const entry of declared) {
	const normalized = entry.replace(/^\.\//, "");
	if (!set.has(normalized)) {
		console.error(`pack-check: pi.extensions entry "${entry}" is not in the tarball`);
		process.exit(1);
	}
}
if (declared.length === 0) {
	console.error("pack-check: package.json has no pi.extensions manifest; local installs cannot discover the gate");
	process.exit(1);
}

const missing = REQUIRED.filter((p) => !set.has(p));
const forbidden = files.filter((p) => FORBIDDEN_PATTERNS.some((pattern) => pattern.test(p)));

if (missing.length > 0 || forbidden.length > 0) {
	if (missing.length > 0) console.error(`pack-check: missing from tarball:\n  ${missing.join("\n  ")}`);
	if (forbidden.length > 0) console.error(`pack-check: forbidden files in tarball:\n  ${forbidden.join("\n  ")}`);
	process.exit(1);
}
console.log(`pack-check: ok (${files.length} files)`);
