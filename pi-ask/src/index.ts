import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAnswerCommands } from "./answer-commands.ts";
import { registerAskSettingsCommand } from "./ask-settings-command.ts";
import { registerAskTool } from "./ask-tool.ts";
import { getAskConfigStore, resetAskConfigStore } from "./config/store.ts";
import { resolveAskFeatures } from "./features.ts";
import { registerAskRecovery } from "./recovery.ts";
import { createAskRuntime } from "./runtime.ts";

export default async function askExtension(pi: ExtensionAPI) {
	resetAskConfigStore();
	// Schema-shaping settings are fixed here, so toggling them takes a reload
	// and never invalidates the prompt cache mid-session.
	const features = resolveAskFeatures(await getAskConfigStore().peek());
	const runtime = createAskRuntime(pi);
	registerAskTool(pi, { features, runtime });
	registerAskRecovery(pi, runtime);
	registerAskSettingsCommand(pi);
	registerAnswerCommands(pi);
}
