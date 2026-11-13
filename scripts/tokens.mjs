import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { getEncoding } from "js-tiktoken";
import { isMain } from "./lib.mjs";

const encoders = new Map();
const supported = ["o200k_base", "cl100k_base"];

/** Count literal text, not chat framing or provider-specific request overhead. */
export function countTokens(text, { encoding = "o200k_base" } = {}) {
  if (typeof text !== "string") throw new TypeError("Expected text to be a string");
  if (!supported.includes(encoding)) throw new Error(`Unsupported encoding: ${encoding}. Use ${supported.join(" or ")}`);
  if (!encoders.has(encoding)) encoders.set(encoding, getEncoding(encoding));
  // Treat special-token-looking strings as ordinary text, including untrusted tool output.
  return {
    tokens: encoders.get(encoding).encode(text, [], []).length,
    encoding,
    scope: "text-only",
  };
}

const help = `Usage: node scripts/tokens.mjs [--text <text> | --file <path>] [--encoding <name>]

Reads UTF-8 stdin when neither --text nor --file is supplied.
Outputs JSON. Encodings: o200k_base (default), cl100k_base.
Counts literal text only; excludes chat framing, tools, images, and provider overhead.
Exact for the selected tokenizer, not a universal Claude/Gemini/model token count.
No network calls. Input text is not included in the output.
`;

if (isMain(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: {
      text: { type: "string" }, file: { type: "string" },
      encoding: { type: "string", default: "o200k_base" },
      help: { type: "boolean", short: "h" },
    } });
    if (values.help) process.stdout.write(help);
    else {
      if (values.text !== undefined && values.file !== undefined) throw new Error("Use either --text or --file, not both");
      if (values.text === undefined && values.file === undefined && process.stdin.isTTY) throw new Error("Provide --text, --file, or piped stdin (see --help)");
      const text = values.text ?? readFileSync(values.file ?? 0, "utf8");
      process.stdout.write(JSON.stringify(countTokens(text, { encoding: values.encoding })) + "\n");
    }
  } catch (error) {
    console.error(`tokens: ${error.message}`);
    process.exitCode = 1;
  }
}
