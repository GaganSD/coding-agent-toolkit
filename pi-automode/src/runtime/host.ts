/**
 * Host shell/environment options read from Pi's effective settings
 * (pi.getSettings()). While Off, the stock tools run unchanged with exactly
 * these options. While On, ambient shell startup customization makes
 * deterministic shell review impossible, so bash is rejected instead.
 *
 * Disclosure endpoint/consent binding lives in core (../core/disclosure.js);
 * it is the single source of truth for the normalized endpoint scheme.
 */
export interface HostShellOptions {
	shellPath?: string;
	shellCommandPrefix?: string;
	imageAutoResize?: boolean;
}

/** Ambient startup customizations that are incompatible with deterministic shell autorun. */
export function ambientShellCustomizations(host: HostShellOptions): string[] {
	const found: string[] = [];
	if (typeof host.shellCommandPrefix === "string" && host.shellCommandPrefix.length > 0) {
		found.push("shellCommandPrefix");
	}
	if (typeof host.shellPath === "string" && host.shellPath.length > 0) {
		found.push("shellPath");
	}
	return found;
}
