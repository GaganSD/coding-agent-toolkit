import {
  estimateTokens,
  sessionEntryToContextMessages,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";

export function estimateContextTokensFromEntries(entries: readonly SessionEntry[]): number {
  let tokens = 0;
  for (const entry of entries) {
    for (const message of sessionEntryToContextMessages(entry)) {
      tokens += estimateTokens(message);
    }
  }
  return tokens;
}

export function sessionSpend(entries: readonly SessionEntry[]): number {
  let cost = 0;
  for (const entry of entries) {
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      cost += usageCost(entry.usage);
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "assistant" || message.role === "toolResult") {
      cost += usageCost("usage" in message ? message.usage : undefined);
    }
  }
  return cost;
}

export function resolveContextTokens(
  usage: { tokens: number | null; percent: number | null; contextWindow: number } | undefined,
  contextEntries: readonly SessionEntry[],
  modelWindow?: number,
): { tokens: number | null; percent: number | null } {
  if (usage?.tokens != null && Number.isFinite(usage.tokens)) {
    return { tokens: usage.tokens, percent: usage.percent };
  }
  const tokens = estimateContextTokensFromEntries(contextEntries);
  const window = usage?.contextWindow || modelWindow;
  if (!window || window <= 0) return { tokens, percent: null };
  return { tokens, percent: (tokens / window) * 100 };
}

type UsageSnapshot = ReturnType<typeof resolveContextTokens> & { contextWindow: number | null; estimated: boolean };

export class ContextUsageCache {
  private cached?: { key: string; value: UsageSnapshot };

  reset(): void { this.cached = undefined; }

  get(ctx: Pick<ExtensionContext, "model" | "sessionManager" | "getContextUsage">): UsageSnapshot {
    const model = ctx.model;
    const session = ctx.sessionManager;
    const modelWindow = model?.contextWindow;
    const sessionId = session.getSessionId?.(), leaf = session.getLeafId?.();
    // Virtual models can route to different physical limits without changing the selected model.
    const key = sessionId !== undefined && leaf !== undefined && model?.api !== "pi-virtual"
      ? JSON.stringify([sessionId, leaf, model?.provider, model?.id, model?.api, modelWindow]) : undefined;
    if (key !== undefined && this.cached?.key === key) return this.cached.value;
    try {
      const usage = ctx.getContextUsage();
      const estimated = usage?.tokens == null || !Number.isFinite(usage.tokens);
      const value = {
        ...resolveContextTokens(usage, estimated ? session.buildContextEntries() : [], modelWindow),
        contextWindow: usage?.contextWindow ?? modelWindow ?? null, estimated,
      };
      if (key !== undefined && (usage !== undefined || !modelWindow || modelWindow <= 0)) this.cached = { key, value };
      return value;
    } catch {
      this.reset();
      return { tokens: null, percent: null, contextWindow: modelWindow ?? null, estimated: true };
    }
  }
}

function usageCost(usage: { cost?: { total?: number } } | undefined): number {
  const total = usage?.cost?.total;
  return typeof total === "number" && Number.isFinite(total) ? total : 0;
}
