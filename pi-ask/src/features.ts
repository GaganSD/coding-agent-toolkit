import type { AskConfig } from "./config/schema.ts";
import type { AskSchemaFeatures } from "./schema.ts";

/**
 * Optional model-facing surface of `ask_user`. Disabled features are absent
 * from the registered schema, so they cost no recurring context.
 */
export type AskFeatures = AskSchemaFeatures;

export const NO_ASK_FEATURES: AskFeatures = {
	background: false,
	expiry: false,
};

export const ALL_ASK_FEATURES: AskFeatures = {
	background: true,
	expiry: true,
};

/** Read once at registration, so a config change applies on reload only. */
export function resolveAskFeatures(
	config: Pick<AskConfig, "behaviour" | "expiry">
): AskFeatures {
	return {
		background: config.behaviour.background,
		expiry: config.expiry.enabled,
	};
}
