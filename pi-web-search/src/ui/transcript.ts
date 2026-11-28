import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { WebSearchDetails } from "../format.ts";
import { EXCERPT_MAX_CHARS } from "../format.ts";
import { CREDENTIAL_PROVIDER_IDS } from "../env.ts";
import { parseCodeQuery } from "../providers/grep.ts";
import { isCodeSource, type EvidenceProvider } from "../providers/types.ts";
import type { SearchInput } from "../search.ts";
import { REF_PASSAGE_CHARS } from "../search_read.ts";
import { providerName } from "./provider-names.ts";

export interface TranscriptState { storedCount?: number }
type RenderContext = { args: SearchInput; isError: boolean; state: TranscriptState; durationMs?: number };
type Hit = NonNullable<WebSearchDetails["searchResults"]>[number];
type QueryGroup = NonNullable<WebSearchDetails["queryGroups"]>[number];
type Row = { hit: Hit; unparsed: boolean; clippedExcerpt?: boolean; label?: string; ref?: string };

export const plainLine = (value: string) => stripTerminalSequences(value).replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ");
const joined = (...parts: (string | undefined | false)[]) => parts.filter(Boolean).join(" · ");
const oneLine = (text: string) => ({ render: (width: number) => [truncateToWidth(text, width)], invalidate() {} });
const countOf = (n: number, unit: string, plural = unit + "s") => `${n} ${n === 1 ? unit : plural}`;
const duration = (ms?: number) => ms === undefined ? undefined : `${(ms / 1000).toFixed(1)}s`;

function safeArgs(raw: unknown): SearchInput {
	if (!raw || typeof raw !== "object") return {};
	const { query, urls, ref, find, scope, effort } = raw as Partial<Record<keyof SearchInput, unknown>>;
	return {
		query: typeof query === "string" || Array.isArray(query) && query.every((term) => typeof term === "string") ? query : undefined,
		ref: typeof ref === "string" ? ref : undefined,
		find: typeof find === "string" ? find : undefined,
		urls: Array.isArray(urls) && urls.every((url) => typeof url === "string") ? urls : undefined,
		scope: scope === "code" || scope === "web" || scope === "both" ? scope : undefined,
		effort: effort === "thorough" || effort === "fast" ? effort : undefined,
	};
}

export function renderCall(raw: unknown, theme: Theme, context: { state: TranscriptState }) {
	const title = theme.fg("toolTitle", theme.bold("search"));
	// Pi constructs the call component before the result component. Read the
	// shared state at render time so saved result counts are available in both.
	return {
		render(width: number) {
			const args = safeArgs(raw);
			const code = args.scope === "code";
			const parsed = code && typeof args.query === "string" ? parseCodeQuery(args.query) : undefined;
			const index = args.ref?.match(/:(\d+)$/)?.[1];
			const total = context.state.storedCount;
			const tag = args.ref !== undefined ? (index ? `result ${index}${total === undefined ? "" : ` of ${total}`}` : "saved results")
				: args.urls ? countOf(args.urls.length, "URL")
				: joined(code && "code", parsed?.repo, parsed?.languages.join(", "), (args.effort === "thorough" || args.scope === "both") && "multi-source");
			const query = Array.isArray(args.query) && args.query.length ? ` ${theme.fg("text", countOf(args.query.length, "query", "queries"))}`
				: typeof args.query !== "string" ? "" : ` ${theme.fg("text", JSON.stringify(plainLine(parsed?.literal ?? args.query)))}`;
			return [truncateToWidth(`${title}${query}${tag ? ` ${theme.fg("muted", plainLine(tag))}` : ""}`, width)];
		},
		invalidate() {},
	};
}

function domain(raw?: string): string | undefined {
	if (!raw) return;
	try { return new URL(raw).hostname || undefined; } catch { return; }
}

function destinations(hits: Hit[], sources: WebSearchDetails["sources"]) {
	const domains = [...new Set([...hits, ...(sources ?? [])].flatMap((hit) => domain(hit.url) ?? []))];
	return domains.length ? `${domains.slice(0, 3).join(", ")}${domains.length > 3 ? ` +${domains.length - 3}` : ""}` : undefined;
}

function sourceProviders(source?: string): EvidenceProvider[] {
	return source?.split(", ").filter((id): id is EvidenceProvider => Object.hasOwn(providerName, id)) ?? [];
}

function provenance(providers: EvidenceProvider[]): string | undefined {
	const names = [...new Set(providers)].flatMap((id) => Object.hasOwn(providerName, id) ? [providerName[id]] : []);
	return names.length ? `via ${names.join(" + ")}` : undefined;
}

function resultProviders(details: WebSearchDetails, hits: Hit[]): EvidenceProvider[] {
	const passage = sourceProviders(details.passageSource);
	if (passage.length) return passage;
	return [...new Set([
		...(details.contributors ?? details.providers ?? (details.provider ? [details.provider] : [])),
		...hits.flatMap((hit) => sourceProviders(hit.source)),
		...(details.queryGroups ?? []).flatMap((group) => group.providers ?? []),
	])];
}

function safeRef(ref?: string): string | undefined {
	return ref && /^[A-Za-z0-9_-]{1,64}(?::[1-9][0-9]{0,2})?$/u.test(ref) ? ref : undefined;
}

function codeLocation(hit: Hit) {
	const path = hit.url?.replace(/^https?:\/\/[^/]+/u, "");
	const sourcegraph = hit.url?.startsWith("https://sourcegraph.com/") && path && /^\/(.+?)(?:@[^/]+)?\/-\/blob\/([^?#]+)/u.exec(path);
	const line = hit.url?.match(/(?:#L|[?&]L=)(\d+)/u)?.[1];
	if (sourcegraph) return { repo: sourcegraph[1], file: decodePath(sourcegraph[2]), line };
	const url = path && /\/(.+?)\/blob\/[A-Za-z0-9._%-]+\/([^?#]+)/u.exec(path);
	const title = hit.title?.replace(/^github\.com\//, "").match(/^([^/]+\/[^/]+)(?:\/(.+))?$/u);
	const repo = title?.[1] ?? (url ? url[1] : undefined);
	const file = title?.[2] ?? (url ? url[2] : undefined);
	return { repo, file, line };
}

function decodePath(path: string) {
	try { return decodeURIComponent(path); } catch { return path; }
}

function partialRetrieval(details: WebSearchDetails) {
	return details.failedProviders?.length ? `partial retrieval · ${details.failedProviders.map((kind) => providerName[kind]).join(", ")} unavailable` : undefined;
}

function unusual(details: WebSearchDetails, showWithheld = true) {
	const unread = Math.max(0, (details.urlsRequested ?? 0) - (details.urlsRead ?? 0));
	return [details.cached && "cached", unread > 0 && `${unread} couldn't be read`, details.classifierStatus === "ran" && "ranked",
		["skipped", "unavailable"].includes(details.classifierStatus ?? "") && "ranking skipped",
		partialRetrieval(details),
		unreadableNotice(details),
		details.incompleteSearch && "Search incomplete",
		showWithheld && details.withheldMatches && "Non-public or unverifiable matches withheld",
		details.storedClipped && "Saved evidence limited by local storage",
		details.classifier?.suppressed ? `${details.classifier.suppressed} hidden as unsafe` : undefined];
}

// Use only formatted warnings. Some diagnostics append a provider reply after
// the colon; keep the condition, never the quoted reply, even on older results.
function expandedWarnings(details: WebSearchDetails): string[] {
	const covered = new Set(unusual(details));
	const lines = new Set<string>();
	for (const raw of details.warnings ?? []) {
		let line = plainLine(raw).replace(/\s+/gu, " ").trim();
		const failedQuery = /^Query (\d+) failed\b/u.exec(line)?.[1];
		if (failedQuery) {
			if (details.queryGroups?.[Number(failedQuery) - 1]?.failed) continue;
			line = `Query ${failedQuery} failed.`;
		} else if (/^grep\.app found no matches in repo:.* That repository may not be indexed;/u.test(line)) {
			line = "Repository may not be indexed; retry without repo: or use a shorter identifier.";
		} else if (details.withheldMatches) {
			// Free-form diagnostics have no per-hit provenance.
			continue;
		} else if (/^grep\.app (?:replied with content this tool could not parse:|returned an empty reply)/u.test(line)) {
			if (details.unreadableProviders?.includes("grep")) continue;
			line = "Couldn’t interpret grep.app’s response";
		} else if (/^(?:Sourcegraph search was incomplete:|GitHub code search returned incomplete results)/u.test(line)) {
			line = "Search incomplete";
		} else if (/^classifier (?:skipped|judging unavailable):/u.test(line)) {
			line = "ranking skipped";
		} else if (line === "Reused session evidence (at most 30 seconds old).") {
			line = "cached";
		} else if (/^(?:\w+ failed \(\w+\)|(?:URL fetch|parallel fetch) failed(?: \(\w+\))?|Exa fetch failed for .*?):/u.test(line)) {
			if (details.failedProviders?.some((id) => line.startsWith(`${id} failed (`))) continue;
			line = "Provider request failed.";
		} else {
			if (details.classifier?.suppressed && /^classifier (?:suppressed|withheld) /u.test(line)) continue;
			// Preview and budget notices can cover fields absent from the transcript.
			if (/^Result (?:excerpts truncated for |metadata truncated to )/u.test(line)) continue;
			if ((details.urlsRequested ?? 0) > (details.urlsRead ?? 0) && /^Jina URL \d+ failed \(/u.test(line)) continue;
		}
		if (line && !covered.has(line)) lines.add(line);
	}
	return [...lines];
}

function unreadableNotice(details: WebSearchDetails) {
	const names = details.unreadableProviders?.map((kind) => providerName[kind]);
	return names?.length ? `Couldn’t interpret ${names.join(", ")}’s response` : undefined;
}

const unparsedNotice = "Unparsed provider reply";
const isUnparsed = (details: WebSearchDetails, hit: Hit, index: number) => hit.type === "unparsed" || details.unparsedRows?.includes(index) === true;

function resultRows(details: WebSearchDetails): Row[] {
	const hits = details.searchResults ?? [];
	const citedUrls = new Set(hits.map((hit) => hit.url));
	const sources = (details.sources ?? []).filter((source) => !citedUrls.has(source.url));
	const clipped = new Set(details.clippedExcerptRows);
	let visibleHits = 0;
	return [...hits, ...sources].map((hit: Hit, index) => {
		const unparsed = isUnparsed(details, hit, index);
		const ref = safeRef(hit.ref);
		const ordinal = unparsed ? undefined : String(++visibleHits);
		return { hit, unparsed, ref, clippedExcerpt: clipped.has(index), label: ordinal && (ref?.split(":")[1] ?? ordinal) };
	});
}

function groupCount(group: QueryGroup, rows: Row[]): number {
	return group.resultCount ?? rows.filter((row) => !row.unparsed).length + (group.sources?.length ?? 0);
}

function compact(details: WebSearchDetails, args: SearchInput, rows: Row[], providers: EvidenceProvider[], hasContinuation: boolean): string {
	const hits = rows.filter((row) => !row.unparsed).map(({ hit }) => hit);
	const unparsed = details.unparsedReply || hits.length < rows.length;
	const where = destinations(hits, details.queryGroups?.flatMap((group) => group.sources ?? []));
	const via = provenance(providers);
	const time = details.cached ? undefined : duration(details.durationMs);
	const count = hits.length || (unparsed ? 0 : details.resultCount ?? 0);
	const notices = [...unusual(details), unparsed && unparsedNotice];
	if (details.passage) {
		const p = details.passage;
		const length = details.searchResults?.[0]?.citedText?.length ?? 0;
		const range = length ? `characters ${p.offset + 1}–${p.offset + length} of ${p.totalChars}` : `0 of ${p.totalChars} characters returned`;
		return joined(where, range, hasContinuation && "more text", via, ...notices,
			p.matches && args.find ? `matched ${JSON.stringify(plainLine(args.find))}` : undefined);
	}
	if (args.ref) return joined(countOf(details.storedCount ?? count, unparsed ? "saved item" : "saved result"), hasContinuation && "more results", via, where, ...notices);
	if (details.urlsRequested !== undefined) {
		const total = details.urlsRequested;
		const read = Math.min(total, details.urlsRead ?? 0);
		return joined(`Read ${read} of ${total} ${total === 1 ? "page" : "pages"}`, via, where, ...notices, time);
	}
	if (details.queryGroups?.length) {
		const groups = details.queryGroups;
		const total = groups.reduce((n, group, index) => n + groupCount(group, rows.filter(({ hit }) => hit.queryGroup === index)), 0);
		const failed = groups.filter((group) => group.failed).length;
		return joined(countOf(total, "result"), countOf(groups.length, "query", "queries"), via, failed > 0 && `${failed} failed`, ...notices, where, time);
	}
	if (!count) {
		const searched = via ?? provenance(details.attempted ?? []);
		if (unparsed) return joined(...notices, searched, time);
		if (details.classifier?.suppressed) return joined("No visible results", searched, ...unusual(details), time);
		if (details.withheldMatches) return joined("No public matches shown", searched, ...unusual(details, false), time);
		if (details.unreadableProviders?.length || details.incompleteSearch) return joined(...unusual(details), searched, time);
		if (details.scope === "code" && !providers.includes("context7")) return joined("No matches", searched, ...notices, time);
		return joined("No results", searched, ...notices, time);
	}
	if (details.scope === "code" && !providers.includes("context7")) {
		const locations = hits.map((hit) => codeLocation(hit));
		const files = new Set(hits.map((hit, i) => locations[i].file ? `${locations[i].repo}/${locations[i].file}` : hit.url?.split("#")[0]).filter(Boolean));
		const repos = [...new Set(locations.flatMap(({ repo }) => repo ?? []))];
		return joined(countOf(count, "match", "matches") + (files.size ? ` in ${countOf(files.size, "file")}` : ""),
			via,
			repos.length === 1 ? repos[0] : typeof args.query === "string" ? parseCodeQuery(args.query).repo : undefined,
			...notices, time);
	}
	const unit = providers.length === 1 && providers[0] === "context7" ? "documentation result" : "result";
	return joined(countOf(count, unit), via, ...notices, where, time);
}

function humanError(d: WebSearchDetails, args: SearchInput): string {
	const error = d.error;
	if (d.parallelHttpStatus === 401 || d.parallelHttpStatus === 403) return "Parallel rejected access. /web-search to check the key in Accounts.";
	if (d.webUnavailable) return "No web provider is ready. /web-search to check providers and Accounts.";
	const names = (d.attempted ?? []).map((kind) => providerName[kind]);
	const list = new Intl.ListFormat("en", { type: "conjunction" }).format(names);
	if (error?.code === "rate_limited" || d.parallelHttpStatus === 429) {
		return `Couldn't search. ${list && (d.allRateLimited || names.length === 1)
			? `${list} ${names.length === 1 ? "is" : names.length === 2 ? "are both" : "are"} rate limited.` : "A provider is rate limited."} Try again in a minute.`;
	}
	switch (error?.code) {
		case "invalid_input":
		case "scope_conflict":
		case "blocked_private_network": {
			const prefix = `search failed (${error.code}): `;
			const diagnostic = error.message.startsWith(prefix) ? error.message.slice(prefix.length) : "";
			return truncateToWidth(plainLine(diagnostic).replace(/\s+/gu, " ").trim(), 220) || (error.code === "blocked_private_network"
				? "URL reading blocked a non-public network address."
				: "Check the search arguments and scope.");
		}
		case "invalid_config": return d.thoroughOff || error.message.includes("thorough search is disabled")
			? "Multi-source is off. /web-search to turn it on."
			: `Search settings are broken${d.configIssue ? `: ${d.configIssue}` : ""}. /web-search to fix.`;
		case "timeout": return `Timed out${d.durationMs === undefined ? "" : ` after ${Math.max(1, Math.round(d.durationMs / 1000))}s`}${list ? ` on ${list}` : ""}. Try again.`;
		case "missing_credentials": return "No provider is ready. /web-search to check Accounts.";
		case "network_error": return `Couldn't reach ${list || "the search provider"}. Check your connection.`;
		case "aborted": return "Search cancelled. Run it again to retry.";
		case "parse_error": return args.ref ? "Couldn't read that saved result. List the saved results or search again." : "Couldn't read the provider's response. Try another provider in /web-search.";
		case "http_error": {
			if (error.status !== 401 && error.status !== 403) break;
			const provider = d.attempted?.at(-1);
			if (provider === "jina") return "Couldn’t read this URL. Check that the page is publicly accessible.";
			if (CREDENTIAL_PROVIDER_IDS.some((id) => id === provider)) return `${names.at(-1)} rejected access. /web-search to check the key.`;
			break;
		}
		case "unknown": if (!names.length) return "Couldn't run this search. Check the query, URLs or saved result."; break;
	}
	return `Couldn't search${list ? ` with ${list}` : ""}. Try another provider in /web-search.`;
}

function renderRow({ hit, unparsed, clippedExcerpt, label, ref }: Row, width: number, theme: Theme, isSavedRead: boolean,
	showProvider: boolean, fallbackSource?: string): string[] {
	const indent = " ".repeat(Math.min(label ? label.length + 2 : 2, Math.max(0, width - 1)));
	const source = hit.source ?? fallbackSource;
	const providers = sourceProviders(source);
	const code = !unparsed && isCodeSource(source);
	const loc = code && providers.some((id) => id !== "context7" && isCodeSource(id)) ? codeLocation(hit) : undefined;
	const title = theme.bold(plainLine(unparsed ? unparsedNotice : loc?.repo ?? hit.title ?? domain(hit.url) ?? `Result ${label ?? ""}`.trim()));
	const path = loc?.file ? ` ${theme.fg("dim", plainLine(loc.file + (loc.line ? `:${loc.line}` : "")))}` : "";
	const metadata = joined(!loc?.repo && domain(hit.url), showProvider && provenance(providers), ref && `ref ${ref}`);
	const excerpt = hit.citedText ?? "";
	const limit = isSavedRead ? REF_PASSAGE_CHARS : EXCERPT_MAX_CHARS;
	const preview = excerpt.length > limit ? excerpt.slice(0, limit).replace(/[\uD800-\uDBFF]$/u, "") : excerpt;
	const text = (excerpt.length > limit || clippedExcerpt) && !preview.endsWith("…") ? `${preview}…` : preview;
	const gutter = code && width - indent.length > 2 ? `${theme.fg("dim", "│")} ` : "";
	return [
		...wrapTextWithAnsi(`${label ? theme.fg("muted", label) + "  " : ""}${title}${path}`, width),
		...(metadata ? wrapTextWithAnsi(indent + theme.fg("dim", metadata), width) : []),
		...(text ? (code || isSavedRead ? text.split(/\r?\n/u) : [text.replace(/\s+/gu, " ").trim()]).flatMap((line) =>
			wrapTextWithAnsi(theme.fg("muted", plainLine(line)), Math.max(1, width - indent.length - (gutter ? 2 : 0)))
				.map((wrapped) => indent + gutter + wrapped)) : []),
	];
}

function continuation(details: WebSearchDetails, args: SearchInput): [label: string, command: string] | undefined {
	const ref = safeRef(details.ref);
	if (args.ref && ref && details.more && details.cursor && /^[A-Za-z0-9_-]{11}$/u.test(details.cursor)) {
		return [details.passage ? "Continue reading" : "Continue listing", `search({ref: ${JSON.stringify(ref)}, cursor: ${JSON.stringify(details.cursor)}})`];
	}
	const resultId = safeRef(details.resultId);
	if (!args.ref && resultId && !resultId.includes(":")) {
		const label = details.storedCount === undefined ? "List saved results" : `List ${countOf(details.storedCount, "saved result")}`;
		return [label, `search({ref: ${JSON.stringify(resultId)}})`];
	}
}

export function renderResult(result: AgentToolResult<WebSearchDetails>, { expanded, isPartial }: { expanded: boolean; isPartial: boolean }, theme: Theme, context: RenderContext) {
	const args = safeArgs(context.args);
	const details = { durationMs: context.durationMs, ...result.details };
	if (isPartial) {
		const progress = result.content.find((part) => part.type === "text")?.text;
		return oneLine(theme.fg("dim", plainLine(progress ?? "")));
	}
	if (context.state && args.ref) context.state.storedCount = details.storedCount;
	const error = context.isError || result.isError || details.error !== undefined;
	const groups = details.queryGroups ?? [];
	const rows = resultRows(details);
	const providers = resultProviders(details, rows.filter((row) => !row.unparsed).map(({ hit }) => hit));
	const action = continuation(details, args);
	const summary = error
		? joined(`✕ ${plainLine(details.error ? humanError(details, args) : "Search didn’t run. Check the tool arguments or Pi’s permissions.")}`,
			groups.length > 0 && countOf(groups.length, "query", "queries"))
		: plainLine(compact(details, args, rows, providers, action !== undefined));
	const heading = theme.fg(error ? "error" : "muted", summary);
	if (!expanded) return oneLine(heading);
	const warnings = error ? [] : expandedWarnings(details);
	return {
		render(width: number) {
			const body = heading ? wrapTextWithAnsi(heading, width) : [];
			const showRows = (entries: Row[], groupProviders: EvidenceProvider[], fallbackSource?: string) => {
				for (const row of entries) {
					if (body.length) body.push("");
					body.push(...renderRow(row, width, theme, args.ref !== undefined, groupProviders.length > 1 || row.unparsed, fallbackSource));
				}
			};
			for (const [index, group] of groups.entries()) {
				const entries = rows.filter(({ hit }) => hit.queryGroup === index);
				const sources = (group.sources ?? []).map((hit): Row => ({ hit, unparsed: false }));
				const groupProviders = [...new Set([...(group.providers ?? []), ...entries.filter((row) => !row.unparsed).flatMap(({ hit }) => sourceProviders(hit.source))])];
				const count = groupCount(group, entries);
				const status = joined(group.failed && "Failed", countOf(count, "result"), provenance(groupProviders),
					group.duplicates ? `${countOf(group.duplicates, "duplicate")} from earlier queries` : undefined);
				if (body.length) body.push("");
				body.push(...wrapTextWithAnsi(theme.bold(`Query ${index + 1} · ${JSON.stringify(plainLine(group.query))}`), width),
					...wrapTextWithAnsi(theme.fg("muted", status), width));
				const prose = !details.withheldMatches && group.text && plainLine(group.text).replace(/\s+/gu, " ").trim();
				if (prose) body.push(...wrapTextWithAnsi(theme.fg("dim", prose), width));
				showRows([...entries, ...sources], groupProviders, groupProviders.length === 1 ? groupProviders[0] : undefined);
			}
			if (!error) {
				showRows(rows.filter(({ hit }) => hit.queryGroup === undefined || !groups[hit.queryGroup]), providers,
					details.passageSource ?? (args.ref ? details.provider : providers.length === 1 ? providers[0] : undefined));
			}
			if (action && !error) {
				const [label, command] = action;
				if (body.length) body.push("");
				const text = joined(label, command);
				body.push(...wrapTextWithAnsi(theme.fg("dim", visibleWidth(text) <= width ? text : `${label}\n${command}`), width));
			}
			for (const warning of warnings.slice(0, 3)) {
				body.push(theme.fg("dim", visibleWidth(warning) > width ? truncateToWidth(warning, width, "…") : warning));
			}
			if (warnings.length > 3) body.push(theme.fg("dim", `+${warnings.length - 3} more`));
			return body.map((line) => truncateToWidth(line, width));
		},
		invalidate() {},
	};
}
