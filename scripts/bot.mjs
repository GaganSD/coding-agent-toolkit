// meowth-bot workflows: PR review and issue triage through an OpenAI-compatible
// chat endpoint. GitHub access goes through `gh api` with the App token as
// GH_TOKEN; the LLM key never appears in logs or posted content.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const repository = process.env.GITHUB_REPOSITORY;
assert(repository, "GITHUB_REPOSITORY is required");

const MAX_INPUT = 60_000;

function gh(...args) {
	return execFileSync("gh", ["api", ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

async function chat(system, user) {
	const key = process.env.LLM_API_KEY;
	assert(key, "LLM_API_KEY is required");
	const base = (process.env.LLM_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
	const model = process.env.LLM_MODEL ?? "deepseek/deepseek-chat-v3.1";
	const response = await fetch(`${base}/chat/completions`, {
		method: "POST",
		headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
		body: JSON.stringify({
			model,
			messages: [
				{ role: "system", content: system },
				{ role: "user", content: user.slice(0, MAX_INPUT) },
			],
			temperature: 0.2,
		}),
		signal: AbortSignal.timeout(120_000),
	});
	if (!response.ok) throw new Error(`LLM ${model}: HTTP ${response.status}`);
	const data = await response.json();
	const text = data.choices?.[0]?.message?.content;
	assert(typeof text === "string" && text.length > 0, "LLM returned no content");
	return text;
}

function parseJsonObject(text) {
	const match = text.match(/\{[\s\S]*\}/);
	assert(match, "LLM reply had no JSON object");
	return JSON.parse(match[0]);
}

async function reviewPr(number) {
	const diff = gh(`repos/${repository}/pulls/${number}`, "-H", "Accept: application/vnd.github.v3.diff");
	const body = await chat(
		"You are meowth-bot, a terse senior reviewer. Review the diff: bugs and regressions first, " +
		"then security/data-handling, then one nit at most. Reference file:line from the diff. " +
		"Markdown, under 250 words. If the diff is clean, say so in one line. Never quote secrets.",
		diff,
	);
	gh(`repos/${repository}/pulls/${number}/reviews`, "-X", "POST",
		"-f", "event=COMMENT", "-f", `body=${body}\n\n— meowth-bot`);
	console.log(`Posted review on PR #${number}`);
}

async function sortIssue(number) {
	const issue = JSON.parse(gh(`repos/${repository}/issues/${number}`));
	const labels = JSON.parse(gh(`repos/${repository}/labels?per_page=100&paginate`))
		.map((label) => label.name);
	const reply = parseJsonObject(await chat(
		"You are meowth-bot, triaging a GitHub issue. Reply with only a JSON object: " +
		'{"labels": [<0-3 label names chosen verbatim from the provided list>], ' +
		'"comment": <one sentence asking the single most useful clarifying question, or null if the report is complete>}. ' +
		"Pick no label rather than a wrong label.",
		`Labels: ${labels.join(", ")}\n\nTitle: ${issue.title}\n\n${issue.body ?? ""}`,
	));
	const chosen = (Array.isArray(reply.labels) ? reply.labels : [])
		.filter((name) => labels.includes(name)).slice(0, 3);
	if (chosen.length > 0) {
		gh(`repos/${repository}/issues/${number}/labels`, "-X", "PUT",
			...chosen.flatMap((name) => ["-f", `labels[]=${name}`]));
	}
	if (typeof reply.comment === "string" && reply.comment.length > 0) {
		gh(`repos/${repository}/issues/${number}/comments`, "-X", "POST", "-f", `body=${reply.comment}\n\n— meowth-bot`);
	}
	console.log(`Triaged issue #${number}: ${chosen.join(", ") || "no labels"}`);
}

const [command, number] = process.argv.slice(2);
if (command === "review-pr") await reviewPr(number);
else if (command === "sort-issue") await sortIssue(number);
else throw new Error("Usage: node scripts/bot.mjs review-pr|sort-issue <number>");
