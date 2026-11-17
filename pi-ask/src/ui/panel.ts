/**
 * The background panel: one question form drawn as a widget above Pi's
 * editor. The editor stays where it is and keeps its text; the keyboard goes
 * to whichever of the two has TUI focus.
 *
 * This file is only the Pi/TUI wiring. What is shown, and who owns the
 * keyboard, is decided in `state/panel.ts` and applied through `apply`.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AskConfig } from "../config/schema.ts";
import type { AskDraftSnapshot } from "../journal/entries.ts";
import type { ExpiryTimer } from "../state/expiry.ts";
import type { AskPanelView } from "../state/panel.ts";
import type { AskParams, AskResult, AskState } from "../types.ts";
import { type AskFlowComponent, createAskFlowController } from "./controller.ts";

export const ASK_PANEL_WIDGET_KEY = "pi-ask:panel";

type Ui = ExtensionContext["ui"];
type WidgetFactory = Extract<
	Parameters<Ui["setWidget"]>[1],
	(...args: never[]) => unknown
>;
type Tui = Parameters<WidgetFactory>[0];
type Theme = Parameters<WidgetFactory>[1];
type TuiComponent = Parameters<Tui["setFocus"]>[0];

/** `getFocusedComponent` is on the TUI class, not on its interface. */
type FocusAwareTui = Tui & { getFocusedComponent?: () => TuiComponent };

export interface AskPanelForm {
	banner?: string;
	config: AskConfig;
	draft?: AskDraftSnapshot;
	/** Counts down while this form is on screen; see `state/expiry.ts`. */
	expiry?: ExpiryTimer;
	params: AskParams;
	requestId: string;
}

export interface AskPanelCallbacks {
	/** Pi moved the keyboard away from the panel (a dialog, the editor). */
	onBlur(): void;
	/** Pi gave the keyboard back to the panel (a dialog over it closed). */
	onFocus(): void;
	/** The form was submitted or cancelled. */
	onDone(requestId: string, result: AskResult): void;
	/** The user asked to put the panel away. */
	onHide(requestId: string): void;
	/** A key reached the form. */
	onInput?(requestId: string, data: string): void;
	onStateChange(requestId: string, state: AskState): void;
}

export interface AskPanel {
	/**
	 * Make the screen match `view`. `load` is called only when the form to
	 * show is not the one already loaded. Returns false if the keyboard could
	 * not be given to the panel on this host.
	 */
	apply(
		ctx: ExtensionContext,
		view: AskPanelView,
		load: (requestId: string) => AskPanelForm | undefined
	): boolean;
	/** Drop the loaded form without telling anyone; nothing more is called. */
	discard(): void;
	/** Drop the loaded form unless it is one of `requestIds`. */
	retain(requestIds: readonly string[]): void;
	/** The loaded form's live state, including unsaved editor text. */
	state(requestId: string): AskState | undefined;
}

export function createAskPanel(callbacks: AskPanelCallbacks): AskPanel {
	let form: { component: AskFlowComponent; requestId: string } | undefined;
	let mounted: { tui: FocusAwareTui; ui: Ui } | undefined;
	let returnFocus: TuiComponent = null;
	// True while this module moves focus itself, so the TUI's own blur
	// notification is not mistaken for the host taking the keyboard.
	let moving = false;
	let focused = false;

	const shell = {
		get focused() {
			return focused;
		},
		set focused(value: boolean) {
			const changed = focused !== value;
			focused = value;
			if (form) {
				form.component.focused = value;
			}
			if (changed && !moving) {
				if (value) {
					callbacks.onFocus();
				} else {
					callbacks.onBlur();
				}
			}
		},
		render: (width: number) => form?.component.render(width) ?? [],
		handleInput(data: string) {
			form?.component.handleInput(data);
		},
		invalidate() {
			form?.component.invalidate();
		},
		/** Pi removed the widget itself (reload, session switch). */
		dispose() {
			if (mounted) {
				mounted = undefined;
				focused = false;
				returnFocus = null;
			}
		},
	};

	function move(action: () => void) {
		moving = true;
		try {
			action();
		} finally {
			moving = false;
		}
	}

	function releaseFocus() {
		if (!(mounted && focused)) {
			return;
		}
		const { tui } = mounted;
		move(() => tui.setFocus(returnFocus));
		returnFocus = null;
	}

	function takeFocus(): boolean {
		if (!mounted) {
			return false;
		}
		if (focused) {
			return true;
		}
		const { tui } = mounted;
		if (typeof tui.getFocusedComponent !== "function") {
			// Without it the keyboard could not be handed back to the editor.
			return false;
		}
		returnFocus = tui.getFocusedComponent();
		move(() => tui.setFocus(shell as TuiComponent));
		return focused;
	}

	function unloadForm() {
		const loaded = form;
		form = undefined;
		loaded?.component.dispose();
	}

	function unmount() {
		if (!mounted) {
			return;
		}
		releaseFocus();
		const { ui } = mounted;
		mounted = undefined;
		try {
			ui.setWidget(ASK_PANEL_WIDGET_KEY, undefined);
		} catch {
			// A torn-down UI has already dropped the widget.
		}
	}

	function mount(ctx: ExtensionContext, next: AskPanelForm) {
		const build = (tui: Tui, theme: Theme) => {
			mounted = { tui, ui: ctx.ui };
			if (form?.requestId !== next.requestId) {
				unloadForm();
				form = {
					requestId: next.requestId,
					component: createPanelForm(ctx, tui, theme, next, callbacks),
				};
				form.component.focused = focused;
			}
			return shell;
		};
		if (mounted && mounted.ui === ctx.ui) {
			// Same widget, next form: keep the mount and the focus.
			build(mounted.tui, ctx.ui.theme);
			mounted.tui.requestRender();
			return;
		}
		unmount();
		unloadForm();
		ctx.ui.setWidget(ASK_PANEL_WIDGET_KEY, build as never, {
			placement: "aboveEditor",
		});
	}

	return {
		apply(ctx, view, load) {
			if (!(view.visible && view.formId)) {
				unmount();
				return true;
			}
			if (
				!mounted ||
				mounted.ui !== ctx.ui ||
				form?.requestId !== view.formId
			) {
				const next = load(view.formId);
				if (!next) {
					unmount();
					return true;
				}
				mount(ctx, next);
			}
			if (!view.focused) {
				releaseFocus();
				mounted?.tui.requestRender();
				return true;
			}
			const taken = takeFocus();
			mounted?.tui.requestRender();
			return taken;
		},
		discard() {
			unmount();
			unloadForm();
		},
		retain(requestIds) {
			if (form && !requestIds.includes(form.requestId)) {
				unloadForm();
			}
		},
		state(requestId) {
			return form?.requestId === requestId
				? form.component.getState()
				: undefined;
		},
	};
}

function createPanelForm(
	ctx: ExtensionContext,
	tui: Tui,
	theme: Theme,
	form: AskPanelForm,
	callbacks: AskPanelCallbacks
): AskFlowComponent {
	const { requestId } = form;
	return createAskFlowController(
		[tui, theme, undefined, (result) => callbacks.onDone(requestId, result)],
		{
			...form.params,
			banner: form.banner,
			config: form.config,
			ctx,
			cwd: ctx.cwd,
			draft: form.draft,
			expiry: form.expiry && { timer: form.expiry },
			onInput: (data) => callbacks.onInput?.(requestId, data),
			onStateChange: (state) => callbacks.onStateChange(requestId, state),
			panel: { onHide: () => callbacks.onHide(requestId) },
		}
	);
}
