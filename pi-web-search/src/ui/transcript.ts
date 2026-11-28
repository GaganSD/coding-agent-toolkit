import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
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

export const plainLine = (value: string) => stripTerminalSequences(value).replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ");
const joined = (...parts: (string | undefined | false)[]) => parts.filter(Boolean).join(" · ");
const oneLine = (text: string) => ({ render: (width: number) => [truncateToWidth(text, width)], invalidate() {} });
const countOf = (n: number, unit: string, plural = unit + "s") => `${n} ${n === 1 ? unit : plural}`;
const duration = (ms?: number) => ms === undefined ? undefined : `${(ms / 1000).toFixed(1)}s`;

function safeArgs(raw: unknown): SearchInput {
	if (!raw || typeof raw !== "object") return {};
	const { query, urls, ref, find, scope, effort } = raw as Partial<Record<keyof SearchInput, unknown>>;
	return {
		query: typeof query === "string" ? query : undefined,
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
			const parsed = code && args.query !== undefined ? parseCodeQuery(args.query) : undefined;
			const index = args.ref?.match(/:(\d+)$/)?.[1];
			const total = context.state.storedCount;
			const tag = args.ref !== undefined ? (index ? `result ${index}${total === undefined ? "" : ` of ${total}`}` : "saved results")
				: args.urls ? countOf(args.urls.length, "URL")
				: joined(code && "code", parsed?.repo, parsed?.languages.join(", "), (args.effort === "thorough" || args.scope === "both") && "multi-source");
			const query = args.query === undefined ? "" : ` ${theme.fg("text", JSON.stringify(plainLine(parsed?.literal ?? args.query)))}`;
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
		details.classifier?.suppressed ? `${details.classifier.suppressed} hidden as unsafe` : undefined];
}

function unreadableNotice(details: WebSearchDetails) {
	const names = details.unreadableProviders?.map((kind) => providerName[kind]);
	return names?.length ? `Couldn’t interpret ${names.join(", ")}’s response` : undefined;
}

const unparsedNotice = "Unparsed provider reply";
const isUnparsed = (details: WebSearchDetails, hit: Hit, index: number) => hit.type === "unparsed" || details.unparsedRows?.includes(index) === true;

function compact(details: WebSearchDetails, args: SearchInput): string {
	const allHits = details.searchResults ?? [];
	const hits = allHits.filter((hit, i) => !isUnparsed(details, hit, i));
	const unparsed = details.unparsedReply || hits.length < allHits.length;
	const where = destinations(hits, details.sources);
	const time = details.cached ? undefined : duration(details.durationMs);
	const count = hits.length || details.sources?.length || (unparsed ? 0 : details.resultCount ?? 0);
	const notices = [...unusual(details), unparsed && unparsedNotice];
	if (details.passage) {
		const p = details.passage;
		const length = allHits[0]?.citedText?.length ?? 0;
		const range = length ? `characters ${p.offset + 1}–${p.offset + length} of ${p.totalChars}` : `0 of ${p.totalChars} characters returned`;
		return joined(where, range, unparsed && unparsedNotice,
			p.matches && args.find ? `matched ${JSON.stringify(plainLine(args.find))}` : undefined);
	}
	if (args.ref) return joined(countOf(details.storedCount ?? count, unparsed ? "saved item" : "saved result"), where, unparsed && unparsedNotice);
	if (details.urlsRequested !== undefined) {
		const total = details.urlsRequested;
		const read = Math.min(total, details.urlsRead ?? 0);
		return joined(`Read ${read} of ${total} ${total === 1 ? "page" : "pages"}`, where, ...notices, time);
	}
	if (!count) {
		if (unparsed) return joined(...notices, time);
		if (details.classifier?.suppressed) return joined("No visible results", ...unusual(details), time);
		if (details.withheldMatches) return joined("No public matches shown", ...unusual(details, false), time);
		if (details.unreadableProviders?.length || details.incompleteSearch) return joined(...unusual(details), time);
		if (details.scope === "code") return joined("No matches", details.attempted?.map((kind) => providerName[kind]).join(", "), "not proof the code doesn't exist", ...unusual(details), time);
		return joined("No results", ...unusual(details), time);
	}
	if (details.scope === "code") {
		const locations = hits.map((hit) => codeLocation(hit));
		const files = new Set(hits.map((hit, i) => locations[i].file ? `${locations[i].repo}/${locations[i].file}` : hit.url?.split("#")[0]).filter(Boolean));
		const repos = [...new Set(locations.flatMap(({ repo }) => repo ?? []))];
		return joined(countOf(count, "match", "matches") + (files.size ? ` in ${countOf(files.size, "file")}` : ""),
			repos.length === 1 ? repos[0] : parseCodeQuery(args.query ?? "").repo,
			...notices, time);
	}
	const contributing = (details.contributors ?? details.providers)?.length ?? 0;
	return joined(countOf(count, "result") + (contributing > 1 ? ` from ${contributing} sources` : ""), where, ...notices, time);
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

export function renderResult(result: AgentToolResult<WebSearchDetails>, { expanded, isPartial }: { expanded: boolean; isPartial: boolean }, theme: Theme, context: RenderContext) {
	const args = safeArgs(context.args);
	const details = { durationMs: context.durationMs, ...result.details };
	if (isPartial) {
		const progress = result.content.find((part) => part.type === "text")?.text;
		return oneLine(theme.fg("dim", plainLine(progress ?? "")));
	}
	if (context.state && args.ref) context.state.storedCount = details.storedCount;
	const summary = plainLine(compact(details, args));
	if (context.isError || result.isError || details.error) {
		const reason = details.error ? humanError(details, args) : "Search didn’t run. Check the tool arguments or Pi’s permissions.";
		const text = theme.fg("error", `✕ ${plainLine(reason)}`);
		return expanded ? { render: (width: number) => wrapTextWithAnsi(text, width).map((line) => truncateToWidth(line, width)), invalidate() {} } : oneLine(text);
	}
	if (!expanded) return oneLine(theme.fg("muted", summary));

	const hits = details.searchResults ?? [];
	const extra = (details.sources ?? []).filter((source) => !hits.some((hit) => hit.url === source.url));
	const rows: Hit[] = [...hits, ...extra];
	const passageProviders = details.passageSource?.split(", ").filter((tag): tag is EvidenceProvider => Object.hasOwn(providerName, tag));
	const via = passageProviders?.length ? passageProviders : details.contributors ?? details.providers ?? (details.provider ? [details.provider] : []);
	const unparsedOmitted = details.unparsedReply && !hits.some((hit, i) => isUnparsed(details, hit, i));
	const footer = joined(unparsedOmitted && rows.length > 0 && unparsedNotice, via.length > 0 && `via ${via.map((kind) => providerName[kind]).join(" + ")}`, ...(rows.length ? unusual(details) : []),
		rows.length > 0 && duration(details.durationMs), details.excerptsShortened ? `${countOf(details.excerptsShortened, "excerpt")} shortened` : undefined);
	return {
		render(width: number) {
			let visibleHits = 0;
			const body = rows.flatMap((hit, i) => {
				const unparsed = isUnparsed(details, hit, i);
				const number = unparsed ? undefined : String(++visibleHits);
				const label = number ? hit.ref?.match(/:(\d+)$/)?.[1] ?? number : "";
				const indent = " ".repeat(Math.min(label.length + 2, Math.max(0, width - 1)));
				const code = !unparsed && isCodeSource(hit.source ?? details.passageSource ?? (args.ref ? details.provider : undefined));
				const loc = code ? codeLocation(hit) : undefined;
				const safeBold = theme.bold(plainLine(unparsed ? unparsedNotice : loc?.repo ?? hit.title ?? domain(hit.url) ?? `Result ${label}`));
				const path = loc?.file ? ` ${theme.fg("dim", plainLine(loc.file + (loc.line ? `:${loc.line}` : "")))}` : "";
				const excerpt = hit.citedText ?? "";
				const limit = args.ref ? REF_PASSAGE_CHARS : EXCERPT_MAX_CHARS;
				const text = excerpt.length > limit ? excerpt.slice(0, limit).replace(/[\uD800-\uDBFF]$/u, "") + "…" : excerpt;
				const host = domain(hit.url);
				const gutter = code && width - indent.length > 2 ? `${theme.fg("dim", "│")} ` : "";
				return [
					...wrapTextWithAnsi(`${label ? theme.fg("muted", label) + "  " : ""}${safeBold}${path}`, width),
					...(!code && host ? wrapTextWithAnsi(indent + theme.fg("dim", host), width) : []),
					...(text ? (code || args.ref ? text.split(/\r?\n/u) : [text.replace(/\s+/gu, " ").trim()]).flatMap((line) =>
						wrapTextWithAnsi(theme.fg("muted", plainLine(line)), Math.max(1, width - indent.length - (gutter ? 2 : 0)))
							.map((wrapped) => indent + gutter + wrapped)) : []),
					"",
				];
			});
			if (!rows.length || details.passage) body.unshift(...wrapTextWithAnsi(theme.fg("muted", summary), width));
			if (footer) body.push(...wrapTextWithAnsi(theme.fg("dim", footer), width));
			else if (rows.length) body.pop();
			return body.map((line) => truncateToWidth(line, width));
		},
		invalidate() {},
	};
}
