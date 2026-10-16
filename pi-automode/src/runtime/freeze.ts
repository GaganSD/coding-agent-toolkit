/**
 * Defensive validation and freezing of final tool arguments.
 *
 * Pi tool_call hooks receive and mutate the same args object that later flows
 * to tool execute(), and mutations are NOT re-validated by the host. The
 * gate's hook boundary must validate the arguments itself and freeze a private
 * copy before review, so no later mutation can change what was approved
 * versus what runs.
 */

const SUPPORTED_TOOLS = ["read", "edit", "write", "bash"] as const;
export type SupportedTool = (typeof SUPPORTED_TOOLS)[number];

export function isSupportedTool(name: string): name is SupportedTool {
	return (SUPPORTED_TOOLS as readonly string[]).includes(name);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false;
	const proto: unknown = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/**
 * Deep-copy a JSON-shaped value into fresh frozen objects. Throws on
 * functions, symbols, bigints, class instances and circular references —
 * callers fail closed rather than let a silently altered copy through.
 */
export function freezeCopy(value: unknown, seen: Set<unknown> = new Set()): unknown {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return value;
	}
	if (typeof value === "undefined") return value;
	if (Array.isArray(value)) {
		if (seen.has(value)) throw new TypeError("circular structure in tool arguments");
		seen.add(value);
		const copy = value.map((item) => freezeCopy(item, seen));
		seen.delete(value);
		return Object.freeze(copy);
	}
	if (isPlainObject(value)) {
		if (seen.has(value)) throw new TypeError("circular structure in tool arguments");
		seen.add(value);
		const copy: Record<string, unknown> = {};
		for (const key of Object.keys(value)) {
			copy[key] = freezeCopy(value[key], seen);
		}
		seen.delete(value);
		return Object.freeze(copy);
	}
	throw new TypeError(`unsupported value of type ${typeof value} in tool arguments`);
}

export type ArgValidation =
	| { ok: true; args: Record<string, unknown> }
	| { ok: false; reason: string };

function fail(reason: string): ArgValidation {
	return { ok: false, reason };
}

function requireString(args: Record<string, unknown>, key: string, tool: string): string | undefined {
	const value = args[key];
	if (typeof value !== "string") return `${tool}: "${key}" must be a string`;
	return undefined;
}

function requireOptionalNumber(args: Record<string, unknown>, key: string, tool: string): string | undefined {
	const value = args[key];
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) return `${tool}: "${key}" must be a finite number`;
	return undefined;
}

/**
 * Validate post-hook arguments for a supported built-in tool and return a
 * frozen private copy. Unknown extra keys are preserved (stock tools ignore
 * them) but the whole object is frozen so approval binds exactly these bytes.
 */
export function validateToolArgs(tool: string, raw: unknown): ArgValidation {
	if (!isSupportedTool(tool)) {
		return fail(`unsupported tool "${tool}" has no verified Automode route`);
	}
	if (!isPlainObject(raw)) {
		return fail(`${tool}: arguments must be an object`);
	}
	let frozen: Record<string, unknown>;
	try {
		frozen = freezeCopy(raw) as Record<string, unknown>;
	} catch (error) {
		return fail(`${tool}: ${error instanceof Error ? error.message : String(error)}`);
	}

	switch (tool) {
		case "read": {
			return (
				failIf(requireString(frozen, "path", tool)) ??
				failIf(requireOptionalNumber(frozen, "offset", tool)) ??
				failIf(requireOptionalNumber(frozen, "limit", tool)) ?? { ok: true, args: frozen }
			);
		}
		case "bash": {
			return (
				failIf(requireString(frozen, "command", tool)) ??
				failIf(requireOptionalNumber(frozen, "timeout", tool)) ?? { ok: true, args: frozen }
			);
		}
		case "write": {
			return (
				failIf(requireString(frozen, "path", tool)) ??
				failIf(requireString(frozen, "content", tool)) ?? { ok: true, args: frozen }
			);
		}
		case "edit": {
			const pathError = requireString(frozen, "path", tool);
			if (pathError) return fail(pathError);
			const edits = frozen.edits;
			if (!Array.isArray(edits)) return fail('edit: "edits" must be an array');
			for (let i = 0; i < edits.length; i += 1) {
				const entry = edits[i];
				if (!isPlainObject(entry)) return fail(`edit: edits[${i}] must be an object`);
				if (typeof entry.oldText !== "string") return fail(`edit: edits[${i}].oldText must be a string`);
				if (typeof entry.newText !== "string") return fail(`edit: edits[${i}].newText must be a string`);
			}
			return { ok: true, args: frozen };
		}
	}
}

function failIf(reason: string | undefined): ArgValidation | undefined {
	return reason === undefined ? undefined : fail(reason);
}
