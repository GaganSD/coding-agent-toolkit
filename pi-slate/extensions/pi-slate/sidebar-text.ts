/** Display-only strings must never inject terminal commands or extra rows. */
export function sidebarText(value: unknown, max = 512): string {
  if (typeof value !== "string") return "";
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
export function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
