import {
	openKenning,
	silenceSqliteWarning,
	watchChanges,
	type Kenning,
} from 'kenning';

/**
 * One database connection and one change watcher per PROCESS, shared by every
 * session in it (D6). A terminal pi has one session at a time; wherever runs many
 * in one process, and one poller per session there would multiply for nothing.
 * Started by the first session_start, stopped by the last session_shutdown, as
 * the pi docs require (never in the factory: some invocations load extensions
 * without starting a session).
 */
export interface Listener {
	onChange(): void;
}

interface Shared {
	kenning: Kenning;
	listeners: Set<Listener>;
	stop(): void;
}

let shared: Shared | undefined;

export function acquire(listener: Listener): Kenning {
	if (!shared) {
		silenceSqliteWarning();
		const kenning = openKenning();
		kenning.pruneIfDue();
		const listeners = new Set<Listener>();
		const watcher = watchChanges(
			kenning,
			() => {
				for (const l of listeners) l.onChange();
			},
			{intervalMs: Number(process.env.KENNING_POLL_MS) || 1000},
		);
		shared = {
			kenning,
			listeners,
			stop() {
				watcher.stop();
				kenning.close();
			},
		};
	}
	shared.listeners.add(listener);
	return shared.kenning;
}

export function release(listener: Listener): void {
	if (!shared) return;
	shared.listeners.delete(listener);
	if (shared.listeners.size === 0) {
		shared.stop();
		shared = undefined;
	}
}
