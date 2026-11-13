import type { AutomodeSettings } from "../types.js";

/**
 * Disclosure consent binding. Consent is upload authority only when it is
 * bound to the exact selected decision model provider/model, its endpoint, and
 * the canonical workspace; "approved" without all four bindings is NOT
 * consent, and a selected provider/model that differs from the bound pair is
 * NOT consent either.
 *
 * Normalized endpoint scheme (shared contract): `URL.origin + URL.pathname`,
 * http/https only, and never with userinfo, query or fragment — such URLs
 * stay local / are refused rather than leaked to.
 */

/** Current scope includes exact commands, candidate patterns and active decisions. */
export const DISCLOSURE_VERSION = 1;

/** Normalize an endpoint URL, or return null when it is not safe to bind. */
export function normalizeDisclosureEndpoint(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.search !== "" || url.hash !== "") return null;
  return `${url.origin}${url.pathname}`;
}

export interface DisclosureConsentStatus {
  consented: boolean;
  reason: string;
}

/**
 * Decide whether evidence may be disclosed for a native review request.
 *
 * `expected.endpoint` is the credential-free canonical `baseUrl` of the
 * currently selected decision model (normalized here defensively);
 * `expected.workspace` is the canonical workspace (evidence.workspace is
 * already realpath-canonical). Any drift — a different endpoint for the same
 * provider/model, a different workspace, a restart with unbound fields —
 * means not consented.
 */
export function checkDisclosureConsent(
  settings: AutomodeSettings,
  expected: { endpoint: string | null; workspace: string },
): DisclosureConsentStatus {
  if (settings.decisionModel === null) {
    return { consented: false, reason: "no decision model selected" };
  }
  if (settings.disclosureConsent !== "approved") {
    return {
      consented: false,
      reason: `disclosure consent is '${settings.disclosureConsent}', not 'approved'`,
    };
  }
  if (settings.disclosureVersion !== DISCLOSURE_VERSION) {
    return { consented: false, reason: "disclosure scope changed; reselect the decision model to approve command-bearing active review" };
  }
  if (
    settings.disclosureProvider === null ||
    settings.disclosureModel === null ||
    settings.disclosureEndpoint === null ||
    settings.disclosureWorkspace === null
  ) {
    return {
      consented: false,
      reason: "consent is not bound to a provider, model, endpoint and workspace; an unbound 'approved' cannot upload",
    };
  }
  // Fail closed when the current selection is not the bound pair: consent
  // given for one provider/model never covers another.
  if (
    settings.disclosureProvider !== settings.decisionModel.provider ||
    settings.disclosureModel !== settings.decisionModel.model
  ) {
    return {
      consented: false,
      reason: "selected decision model differs from the consented provider/model binding",
    };
  }
  const expectedEndpoint =
    expected.endpoint === null ? null : normalizeDisclosureEndpoint(expected.endpoint);
  if (expectedEndpoint === null) {
    return {
      consented: false,
      reason: "selected model endpoint is missing or not safely normalizable; staying local",
    };
  }
  if (settings.disclosureEndpoint !== expectedEndpoint) {
    return {
      consented: false,
      reason: "selected model endpoint differs from the consented endpoint binding",
    };
  }
  if (settings.disclosureWorkspace !== expected.workspace) {
    return {
      consented: false,
      reason: "current workspace differs from the consented workspace binding",
    };
  }
  return { consented: true, reason: "consent approved and bound to the selected endpoint and workspace" };
}
