import type { ExpiryClock } from "../../src/state/expiry.ts";

/** A clock that moves only when told to; due timers fire in order. */
export function fakeClock() {
	let now = 1_700_000_000_000;
	let next = 1;
	const timers = new Map<number, { at: number; task: () => void }>();
	const clock: ExpiryClock = {
		now: () => now,
		setTimeout(task, ms) {
			const id = next++;
			timers.set(id, { at: now + ms, task });
			return id;
		},
		clearTimeout(handle) {
			timers.delete(handle as number);
		},
	};
	return {
		clock,
		/** Timers still scheduled; zero means nothing is left running. */
		get pending() {
			return timers.size;
		},
		advance(ms: number) {
			const end = now + ms;
			for (;;) {
				const due = [...timers.entries()]
					.filter(([, timer]) => timer.at <= end)
					.sort((a, b) => a[1].at - b[1].at)[0];
				if (!due) {
					break;
				}
				timers.delete(due[0]);
				now = Math.max(now, due[1].at);
				due[1].task();
			}
			now = end;
		},
	};
}
