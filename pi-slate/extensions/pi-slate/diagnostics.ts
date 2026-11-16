export type SlateFeature =
  | "tool-style" | "tool-ownership" | "tool-groups" | "sidebar" | "transcript"
  | "surface-host" | "session-notices" | "command-catalog" | "mcp-catalog" | "dashboard" | "paste-preview" | "configuration";
export type SlateDiagnostic = { feature: SlateFeature; state: "active" | "fallback"; detail: string };

/** Presentation diagnostics are not application/server health. Never notify or retain thrown errors here. */
export class SlateDiagnostics {
  private readonly entries = new Map<SlateFeature, SlateDiagnostic>();
  private readonly failed = new Set<SlateFeature>();

  active(feature: SlateFeature, detail: string): void {
    if (!this.failed.has(feature)) this.entries.set(feature, { feature, state: "active", detail });
  }
  fallback(feature: SlateFeature, detail: string): void {
    if (!this.failed.has(feature)) this.entries.set(feature, { feature, state: "fallback", detail });
  }
  fault(feature: SlateFeature, detail: string): void {
    this.failed.add(feature);
    this.entries.set(feature, { feature, state: "fallback", detail });
  }
  /** Synchronous optional adapters only. A throwing adapter is quarantined until the next session/reload. */
  attempt<T>(feature: SlateFeature, detail: string, operation: () => T, fallback: () => T): T {
    if (this.failed.has(feature)) return fallback();
    try { return operation(); }
    catch {
      this.fault(feature, detail);
      return fallback();
    }
  }
  reset(): void { this.entries.clear(); this.failed.clear(); }
  snapshot(): SlateDiagnostic[] {
    return [...this.entries.values()].map(entry => ({ ...entry })).sort((a, b) => a.feature.localeCompare(b.feature));
  }
  report(slateVersion: string, piVersion: string, surfaces: readonly string[]): string {
    return [
      `Slate ${slateVersion} · Pi ${piVersion}`,
      `Selected surfaces: ${surfaces.join(", ") || "none"}`,
      "",
      "Optional presentation features (not MCP/server health):",
      ...this.snapshot().map(entry => `${entry.feature}: ${entry.state} — ${entry.detail}`),
      ...(this.entries.size ? [] : ["No optional integrations selected or probed."]),
      "",
      "Fallbacks preserve native behavior; no preferences are changed. /reload retries failed adapters.",
      "MCP is configuration-only in Slate. Use /mcp for validation and live connection status.",
    ].join("\n");
  }
}
