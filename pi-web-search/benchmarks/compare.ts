import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { measureFootprint } from "../scripts/footprint.ts";
import { isolatedEnvironment, runCommand, withTemporaryDirectory } from "../scripts/validation.ts";
import { directory, Replay } from "./replay.ts";

const pinned = "4427fb2044adcd176ced091dc82ff787f3b039ff";
const research = resolve(directory, "../research");
const clone = resolve(process.env.PI_WEB_ACCESS_CLONE ?? join(research, ".cache", "pi-web-access"));
const [mode, childClone] = process.argv.slice(2);

if (mode === "--help") console.log("npm run research:compare -- [--help]\nMeasure declaration and prompt size from an existing pinned clone. Set PI_WEB_ACCESS_CLONE to override its default location.");
else if (mode !== "--child") {
	assert.ok(existsSync(join(clone, "package.json")), `Missing pinned pi-web-access checkout at ${clone}. See benchmarks/README.md.`);
	assert.equal(runCommand("git", ["rev-parse", "HEAD"], clone, process.env).trim(), pinned, "Checkout must match the comparison pin");
	assert.equal(runCommand("git", ["status", "--porcelain", "--untracked-files=no"], clone, process.env).trim(), "", "Comparison checkout has modified source");
	withTemporaryDirectory("pi-web-search-compare-", (root) => {
		process.stdout.write(runCommand(process.execPath, [process.argv[1], "--child", clone], root, isolatedEnvironment(root)));
	});
} else {
	const guard = new Replay();
	guard.installGuard();
	const expected = ["web_search", "source_check", "fetch_content", "get_search_content"];
	const own = (await measureFootprint()).modes.default;
	const other = (await measureFootprint(childClone, expected)).modes.default;
	guard.assertClean();
	assert.deepEqual(new Set(other.tools), new Set(expected), "Pinned competitor did not load all four tools");
	const markdown = [
		"# pi-web-access context comparison", "", `Pinned pi-web-access commit \`${pinned}\`.`, "",
		"| Pi extension | Tools | Declaration characters | System prompt delta characters | Estimated tokens |",
		"| --- | ---: | ---: | ---: | ---: |",
		`| pi-web-search | ${own.tools.length} | ${own.declarationChars} | ${own.promptDeltaChars} | ${own.estimatedTokens} |`,
		`| pi-web-access | ${other.tools.length} | ${other.declarationChars} | ${other.promptDeltaChars} | ${other.estimatedTokens} |`,
		"", "Estimates use ceil((declaration characters + prompt delta characters) / 4). No provider payloads, model behavior, or citations were scored.", "",
	].join("\n");
	const output = join(research, "results", "compare.md");
	mkdirSync(resolve(output, ".."), { recursive: true });
	writeFileSync(output, markdown);
	console.log(markdown);
}
