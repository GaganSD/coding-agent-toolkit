import assert from "node:assert/strict";
import test from "node:test";
import { npmDownloadTotals, renderBadge } from "../npm-downloads-badge.mjs";
import { packages } from "../packages.mjs";

const start = "2026-10-26";
const end = "2026-11-24";
const valid = { downloads: 42, start, end };

test("fetches and sums the same rolling npm window for every publishable package", async () => {
  const urls = [];
  const totals = await npmDownloadTotals(async url => {
    urls.push(url);
    return Response.json({ ...valid, downloads: urls.length * 100 });
  });
  assert.deepEqual(urls, Object.values(packages).map(({ name }) =>
    `https://api.npmjs.org/downloads/point/last-month/${encodeURIComponent(name)}`));
  assert.deepEqual(totals, { downloads: urls.length * (urls.length + 1) * 50, start, end });
});

test("does not return a publishable total with missing, invalid, or mismatched counts", async () => {
  await assert.rejects(npmDownloadTotals(async () => new Response(null, { status: 503 })), /HTTP 503/);
  await assert.rejects(npmDownloadTotals(async () => Response.json({ ...valid, downloads: null })), /Invalid npm downloads/);
  await assert.rejects(npmDownloadTotals(async url => Response.json({
    ...valid, end: url.endsWith("/pi-slate") ? "2026-11-25" : end,
  })), /different date windows/);
});

test("renders compact monthly counts with exact totals and the window in the title", () => {
  assert.match(renderBadge({ downloads: 11_767, start, end }), /npm downloads: 11,767 \(2026-10-26 to 2026-11-24\)/);
  for (const [downloads, label] of [[0, "0"], [999, "999"], [11_767, "11.77k"], [100_000, "100k"], [1_130_000, "1.13M"]]) {
    assert(renderBadge({ downloads, start, end }).includes(`>${label}/month</text>`));
  }
});
