import type { AskConfig } from "./config/schema.ts";
import type { AskSchemaFeatures } from "./schema.ts";

/**
 * Optional model-facing surface of `ask_user`. A feature is registered only
 * when its behaviour has shipped AND the user's config leaves it enabled;
 * otherwise its fields are absent from the schema and cost nothing.
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

/**
 * Features whose behaviour is implemented. Flip a flag to `true` in the same
 * change that makes the tool honour the field; config can only narrow this.
 */
export const SHIPPED_ASK_FEATURES: AskFeatures = {
	background: true,
	expiry: false,
};

/** Read once at registration, so a config change applies on reload only. */
export function resolveAskFeatures(
	config: Pick<AskConfig, "behaviour" | "expiry">,
	shipped: AskFeatures = SHIPPED_ASK_FEATURES
): AskFeatures {
	return {
		background: shipped.background && config.behaviour.background,
		expiry: shipped.expiry && config.expiry.enabled,
	};
}
