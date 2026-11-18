/**
 * How a late outcome reaches the agent, as pure decisions.
 *
 * Whether an outcome HAS been delivered is never decided here: that is read
 * from the session branch, where the answer message itself is the proof. This
 * module only picks the next step for outcomes that are not there yet.
 *
 * - `propose`: the agent is working and a turn just ended. The answer is
 *   handed to Pi as a turn-boundary entry, so it joins the running work
 *   without an extra turn being started for it.
 * - `wake`: the agent is idle; the answer starts a turn.
 * - `append`: added to the conversation without starting a turn. Used for
 *   cancellations, and for anything left over after the user aborted the run:
 *   stopping the agent must not be undone by an answer.
 * - `hold`: nothing to do yet. Either the outcome is already on its way, or
 *   the agent is busy and a turn boundary or settle will follow.
 */

export type AskDeliveryAction = "propose" | "wake" | "append" | "hold";

/**
 * `now`: an outcome was just recorded, or the session was (re)built.
 * `boundary`: a turn ended, or the run is about to settle.
 * `settled`: the run is over and Pi will not continue on its own.
 */
export type AskDeliveryTrigger = "now" | "boundary" | "settled";

export interface AskDeliveryItem {
	/** A cancellation: recorded as context, never a reason to start a turn. */
	cancelled: boolean;
	/** Already sent in this process and not yet seen on the branch. */
	inFlight: boolean;
	outcomeId: string;
}

export interface AskDeliverySituation {
	/** The run that just settled was aborted by the user. */
	aborted?: boolean;
	/** `ctx.isIdle()`; ignored for `boundary` and `settled`. */
	idle: boolean;
	trigger: AskDeliveryTrigger;
}

export interface AskDeliveryStep {
	action: AskDeliveryAction;
	outcomeId: string;
}

/** One step per item, in the order given (request order). */
export function planDelivery(
	items: readonly AskDeliveryItem[],
	situation: AskDeliverySituation
): AskDeliveryStep[] {
	// A settled run is idle by definition, whatever the host still reports.
	const idle = situation.trigger === "settled" || situation.idle;
	let woken = false;
	return items.map(({ cancelled, inFlight, outcomeId }) => {
		const step = (action: AskDeliveryAction) => ({ outcomeId, action });
		if (inFlight) {
			return step("hold");
		}
		if (situation.trigger === "boundary") {
			return step("propose");
		}
		// Once one answer has woken the agent, the rest join at its first
		// turn boundary instead of each starting a run.
		if (!idle || woken) {
			return step("hold");
		}
		if (cancelled || situation.aborted) {
			return step("append");
		}
		woken = true;
		return step("wake");
	});
}
