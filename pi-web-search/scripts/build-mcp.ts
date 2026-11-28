import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const typeBoxEntry = new URL(import.meta.resolve("typebox"));
const typeBoxLicense = readFileSync(new URL("../license", typeBoxEntry), "utf8").trim();

// Bundle TypeBox only in the standalone executable. The Pi entrypoint uses the host peer.
await build({
	absWorkingDir: packageRoot,
	entryPoints: ["src/mcp-bin.ts"],
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
	alias: { typebox: fileURLToPath(typeBoxEntry) },
	target: "node22",
	outfile: "dist/mcp.js",
	banner: { js: `/*!\n${typeBoxLicense}\n*/` },
});
