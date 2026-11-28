import spawn from "cross-spawn";
import { githubToken } from "../env.ts";
import { credentialRedactor } from "../providers/http.ts";
import { isProviderError, providerError } from "../providers/types.ts";
import { type DocumentText, documentFromPage, stripMarkdownLinks, textOf } from "./document.ts";
import { type FetchPage, MAX_BODY_BYTES } from "./http.ts";

const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";
const GITHUB = "https://github.com";
const ACCEPT_JSON = "application/vnd.github+json";
const ACCEPT_RAW = "application/vnd.github.raw+json";
const CLI_FIELDS = "title,body,state,url";

export interface GitHubReaderOptions {
	githubToken?: () => string | undefined;
	runGh?: (args: string[], token: string | undefined, signal: AbortSignal) => Promise<string | undefined>;
}

type GitHubResource = {
	owner: string;
	repo: string;
} & (
	{ kind: "repository" }
	| { kind: "tree" | "blob"; segments: string[] }
	| { kind: "pr" | "issue"; number: string }
);

export function githubResource(url: URL): GitHubResource | undefined {
	if (url.hostname !== "github.com" || url.port) return;
	let segments: string[];
	try { segments = url.pathname.slice(1).replace(/\/$/u, "").split("/").map(decodeURIComponent); } catch { return; }
	const [owner, repo, kind, ...rest] = segments;
	if (!/^[\w-]{1,39}$/u.test(owner ?? "") || !/^[\w.-]{1,100}$/u.test(repo ?? "") || /^\.{1,2}$/u.test(repo)) return;
	if (kind === undefined) return { owner, repo, kind: "repository" };
	if ((kind === "pull" || kind === "issues") && rest.length === 1 && /^[1-9]\d{0,12}$/u.test(rest[0])) {
		return { owner, repo, kind: kind === "pull" ? "pr" : "issue", number: rest[0] };
	}
	if ((kind === "tree" && rest.length >= 1) || (kind === "blob" && rest.length >= 2)) {
		if (rest.some((part) => part.split("/").some((segment) => !segment || segment === "." || segment === ".." || /[\x00-\x1f\x7f\\]/u.test(segment)))) return;
		return { owner, repo, kind, segments: rest };
	}
}

const escaped = (segments: string[]) => segments.map(encodeURIComponent).join("/");
const missing = (error: unknown) => isProviderError(error) && error.status === 404;
const record = (value: unknown): Record<string, unknown> | undefined =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export async function readGitHub(
	resource: GitHubResource,
	fetchPage: FetchPage,
	signal: AbortSignal,
	options: GitHubReaderOptions,
): Promise<DocumentText> {
	const { owner, repo, kind } = resource;
	const identifier = `${owner}/${repo}`;
	const repoPath = escaped([owner, repo]);
	if (kind === "blob") {
		const raw = new URL(`${RAW}/${repoPath}/${escaped(resource.segments.flatMap((segment) => segment.split("/")))}`);
		const page = await fetchPage(raw);
		const document = await documentFromPage(page, raw, signal, true);
		return { ...document, title: resource.segments.at(-1), source: "github" };
	}

	// A configured environment or auth.json credential may be used only on GitHub.
	// gh also knows its own auth state; the REST path works anonymously.
	const token = (options.githubToken ?? (() => githubToken({})))();
	const auth = token ? { Authorization: `Bearer ${token}` } : undefined;
	const redact = credentialRedactor(auth);
	const api = (path: string, accept: string, ref?: string, authenticate = true) => {
		const url = new URL(`${API}/repos/${repoPath}${path}`);
		if (ref) url.searchParams.set("ref", ref);
		return fetchPage(url, { Accept: accept, ...(authenticate ? auth : undefined) });
	};
	const json = (body: string): unknown => {
		try { return JSON.parse(body); } catch { throw providerError("parse_error", "GitHub returned an invalid response."); }
	};
	const safe = (text: string) => redact?.(text) ?? text;

	const metadata = record(json(textOf(await api("", ACCEPT_JSON))));
	if (metadata?.private !== false || (metadata.visibility !== undefined && metadata.visibility !== "public")
		|| typeof metadata.full_name !== "string" || metadata.full_name.toLowerCase() !== identifier.toLowerCase()) {
		throw providerError("parse_error", "GitHub URL reading requires a verified public repository.");
	}

	if (kind === "pr" || kind === "issue") {
		const endpoint = kind === "pr" ? "pull" : "issues";
		const expectedUrl = `${GITHUB}/${repoPath}/${endpoint}/${resource.number}`;
		const cli = await (options.runGh ?? runGh)([kind, "view", expectedUrl, "--json", CLI_FIELDS], token, signal);
		const page = cli === undefined ? await api(`/${kind === "pr" ? "pulls" : "issues"}/${resource.number}`, ACCEPT_JSON, undefined, false) : undefined;
		const item = record(json(cli ?? textOf(page!)));
		if (typeof item?.title !== "string") throw providerError("parse_error", "GitHub returned no issue or pull request title.");
		const returned = cli === undefined ? item.html_url : item.url;
		if (typeof returned !== "string" || returned.toLowerCase() !== expectedUrl.toLowerCase()) {
			throw providerError("parse_error", "GitHub returned a different issue or pull request.");
		}
		const title = safe(item.title);
		const state = typeof item.state === "string" ? safe(item.state.toLowerCase()) : undefined;
		const body = typeof item.body === "string" ? stripMarkdownLinks(safe(item.body)) : "";
		return {
			title, source: "github", truncated: page?.truncated,
			text: [`# ${title}`, `${kind === "pr" ? "Pull request" : "Issue"} #${resource.number}${state ? ` (${state})` : ""}`, body].filter(Boolean).join("\n\n"),
		};
	}

	// An explicitly URL-encoded slash stays in the requested branch/tag name. For
	// an ordinary slash, retry a few longer ref prefixes only if GitHub returns 404.
	const segments = kind === "tree" ? resource.segments : [];
	let listing: Awaited<ReturnType<FetchPage>> | undefined;
	let directory: string[] = [];
	let ref: string | undefined;
	for (let prefix = segments.length ? 1 : 0; prefix <= Math.min(segments.length, 5); prefix++) {
		ref = segments.slice(0, prefix).join("/") || undefined;
		directory = segments.slice(prefix);
		try {
			listing = await api(`/contents${directory.length ? `/${escaped(directory)}` : ""}`, ACCEPT_JSON, ref);
			break;
		} catch (error) {
			if (!missing(error) || prefix === Math.min(segments.length, 5)) throw error;
		}
	}
	if (!listing) throw providerError("parse_error", "GitHub returned no directory listing.");
	const items = json(textOf(listing));
	if (!Array.isArray(items)) throw providerError("parse_error", "GitHub returned no directory listing.");
	const names = items.flatMap((item) => {
		const entry = record(item);
		return typeof entry?.name === "string" ? [`- ${safe(entry.name).replace(/[\r\n]/gu, " ")}${entry.type === "dir" ? "/" : ""}`] : [];
	});
	let readme: Awaited<ReturnType<FetchPage>> | undefined;
	for (const path of directory.length ? [`/readme/${escaped(directory)}`, "/readme"] : ["/readme"]) {
		try {
			readme = await api(path, ACCEPT_RAW, ref);
			break;
		} catch (error) {
			if (!missing(error)) throw error;
		}
	}
	const title = safe([identifier, ...directory].join("/"));
	return {
		title,
		source: "github",
		truncated: listing.truncated || readme?.truncated,
		text: [
			`# ${title}`, `## Directory listing\n\n${names.join("\n") || "(empty directory)"}`,
			readme ? `## README\n\n${stripMarkdownLinks(safe(textOf(readme)))}` : "(GitHub returned no README.)",
		].join("\n\n"),
	};
}

async function runGh(args: string[], token: string | undefined, signal: AbortSignal): Promise<string | undefined> {
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const child = spawn("gh", args, {
			stdio: ["ignore", "pipe", "ignore"],
			signal,
			env: { ...process.env, GH_HOST: "github.com", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1",
				...(token ? { GH_TOKEN: token } : {}) },
		});
		let size = 0;
		const chunks: Buffer[] = [];
		child.stdout?.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(providerError("parse_error", "GitHub CLI response exceeded the 5 MiB cap."));
				child.kill();
			} else chunks.push(chunk);
		});
		child.once("error", (error: NodeJS.ErrnoException) => {
			if (signal.aborted) reject(signal.reason);
			else if (error.code === "ENOENT") resolve(undefined);
			else reject(providerError("network_error", "GitHub CLI could not start.", { retryable: false }));
		});
		child.once("close", (code) => {
			if (signal.aborted) reject(signal.reason);
			else resolve(code === 0 ? Buffer.concat(chunks).toString("utf8") : undefined);
		});
	});
}
