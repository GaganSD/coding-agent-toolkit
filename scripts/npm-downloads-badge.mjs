import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isMain } from "./lib.mjs";
import { packages } from "./packages.mjs";

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });
const isoDate = /^\d{4}-\d{2}-\d{2}$/;

export async function npmDownloadTotals(request = fetch) {
  const names = [...new Set(Object.values(packages).map(({ name }) => name))];
  if (!names.length) throw new Error("No npm packages configured");
  const counts = await Promise.all(names.map(async name => {
    const response = await request(`https://api.npmjs.org/downloads/point/last-month/${encodeURIComponent(name)}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`npm downloads for ${name}: HTTP ${response.status}`);
    const { downloads, start, end } = await response.json() ?? {};
    if (!Number.isSafeInteger(downloads) || downloads < 0 || !isoDate.test(start) || !isoDate.test(end) || start > end) {
      throw new Error(`Invalid npm downloads data for ${name}`);
    }
    return { downloads, start, end };
  }));
  const { start, end } = counts[0];
  if (counts.some(row => row.start !== start || row.end !== end)) {
    throw new Error("npm returned different date windows; refusing to publish a mixed total");
  }
  const downloads = counts.reduce((sum, row) => sum + row.downloads, 0);
  if (!Number.isSafeInteger(downloads)) throw new Error("npm download total is outside the safe integer range");
  return { downloads, start, end };
}

export function renderBadge({ downloads, start, end }) {
  const value = `${compact.format(downloads).replace("K", "k")}/month`;
  const labelWidth = 96;
  const valueWidth = Math.ceil(value.length * 7 + 12);
  const width = labelWidth + valueWidth;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-labelledby="title">
  <title id="title">npm downloads: ${downloads.toLocaleString("en-US")} (${start} to ${end})</title>
  <rect width="${labelWidth}" height="20" fill="#18181b"/>
  <rect x="${labelWidth}" width="${valueWidth}" height="20" fill="#10b981"/>
  <g text-anchor="middle" font-family="Verdana, Geneva, sans-serif" font-size="11">
    <text x="${labelWidth / 2}" y="14" fill="#fff">npm downloads</text>
    <text x="${labelWidth + valueWidth / 2}" y="14" fill="#18181b">${value}</text>
  </g>
</svg>
`;
}

if (isMain(import.meta.url)) {
  const output = process.argv[2];
  if (!output) throw new Error("Usage: node scripts/npm-downloads-badge.mjs <output.svg>");
  const totals = await npmDownloadTotals();
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, renderBadge(totals));
  console.log(`npm downloads: ${totals.downloads} (${totals.start} to ${totals.end})`);
}
