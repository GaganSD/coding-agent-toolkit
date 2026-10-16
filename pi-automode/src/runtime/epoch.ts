/**
 * Epoch controller: one invalidation point for every pending gate/approval
 * operation. Off transitions, settings drift, session switch/tree/fork,
 * reload and shutdown all invalidate the current epoch; anything holding an
 * older snapshot must not execute.
 */
export class EpochController {
	#epoch = 0;
	#controller = new AbortController();
	#reason: string | undefined;

	get epoch(): number {
		return this.#epoch;
	}

	/** Aborted when the epoch is invalidated; dismisses open dialogs and wakes queued waiters. */
	get signal(): AbortSignal {
		return this.#controller.signal;
	}

	get invalidatedReason(): string | undefined {
		return this.#reason;
	}

	/** True when the snapshot still matches the live epoch and has not been invalidated. */
	check(snapshot: number): boolean {
		return snapshot === this.#epoch && !this.#controller.signal.aborted;
	}

	invalidate(reason?: string): void {
		this.#epoch += 1;
		this.#reason = reason;
		this.#controller.abort();
		this.#controller = new AbortController();
	}
}
