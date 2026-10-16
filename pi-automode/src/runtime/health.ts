/**
 * Health receipt shared with the launcher. The callback is host/launcher-owned
 * and never agent-facing; a throwing callback must never break the gate.
 */
export interface AutomodeHealth {
	initialized: boolean;
	wrappedTools: string[];
	enabled: boolean;
	error?: string;
}

export type HealthCallback = (health: AutomodeHealth) => void;

export function reportHealth(callback: HealthCallback | undefined, health: AutomodeHealth): void {
	if (!callback) return;
	try {
		callback(health);
	} catch {
		// The launcher health channel must never become a gate dependency.
	}
}
