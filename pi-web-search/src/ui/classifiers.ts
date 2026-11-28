import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AvailableClassifier } from "../providers/config.ts";
import { awaitWithSignal, withTimeout } from "../providers/http.ts";

export interface ListedClassifier extends AvailableClassifier {
	available?: boolean;
}

export async function listSupportedClassifiers(
	registry: ExtensionContext["modelRegistry"] | undefined,
	signal?: AbortSignal,
): Promise<ListedClassifier[]> {
	if (!registry) {
		return [];
	}
	const known = (registry.getModelsOfType?.("classifier") ?? []).map((model) => ({
		provider: model.provider,
		id: model.id,
	}));
	let available: AvailableClassifier[] | undefined;
	try {
		available = await availableClassifiers(registry, signal);
	} catch {
		// Discovery failed (timeout, abort, network): availability is unknown, not missing.
		available = undefined;
	}
	const ready = new Set((available ?? []).map((model) => `${model.provider}/${model.id}`));
	const listed = known.map((model) => ({
		...model,
		available: available === undefined ? undefined : ready.has(`${model.provider}/${model.id}`),
	}));
	if (listed.length > 0) {
		return listed;
	}
	return (available ?? []).map((model) => ({ ...model, available: true }));
}

export class ClassifierDiscoveryError extends Error {}

export async function availableClassifiers(
	registry: ExtensionContext["modelRegistry"] | undefined,
	signal?: AbortSignal,
	timeoutMs = 3_000,
) {
	if (!registry) return [];
	const deadline = withTimeout(signal, timeoutMs);
	try {
		if (deadline.signal.aborted) throw deadline.signal.reason;
		const models = await awaitWithSignal(
			registry.getAvailableOfType("classifier", undefined, { signal: deadline.signal }),
			deadline.signal,
		);
		return models.map((model) => ({ provider: model.provider, id: model.id }));
	} catch {
		throw new ClassifierDiscoveryError(
			"Classifier discovery failed or stopped. Settings did not change. Use /web-search classifier provider/model to select a classifier directly.",
		);
	} finally {
		deadline.dispose();
	}
}
