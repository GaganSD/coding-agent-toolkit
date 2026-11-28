#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { enableStoredCredentials } from "./env.ts";
import { serveStdio } from "./mcp.ts";
import { defaultWebSearchConfigPath } from "./providers/config.ts";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
enableStoredCredentials(join(dirname(defaultWebSearchConfigPath()), "auth.json"));
await serveStdio(process.stdin, process.stdout, version);
