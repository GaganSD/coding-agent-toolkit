/**
 * Serial async mutex with abort-aware acquisition. Used to serialize managed
 * execution while Automode is on (no model sibling write/review races) and
 * to keep the approval dialog strictly one-at-a-time.
 */
export class AsyncMutex {
	#tail: Promise<unknown> = Promise.resolve();

	/**
	 * Acquire the mutex. Resolves to a release function, or undefined when the
	 * signal aborted while queued. An aborted waiter yields its slot as soon
	 * as it arrives so the queue never deadlocks.
	 */
	async acquire(signal?: AbortSignal): Promise<(() => void) | undefined> {
		if (signal?.aborted) return undefined;
		let release!: () => void;
		const slot = new Promise<void>((resolve) => {
			release = resolve;
		});
		const previous = this.#tail;
		this.#tail = previous.then(() => slot);

		if (!signal) {
			await previous;
			return release;
		}
		const aborted = new Promise<"aborted">((resolve) => {
			if (signal.aborted) resolve("aborted");
			else signal.addEventListener("abort", () => resolve("aborted"), { once: true });
		});
		const winner = await Promise.race([previous.then(() => "acquired" as const), aborted]);
		if (winner === "aborted") {
			void previous.then(() => release());
			return undefined;
		}
		return release;
	}
}
