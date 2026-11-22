import type {Shipmates} from './shipmates.js';

/**
 * Call `onChange` whenever anything in the database changed (D6). It polls
 * `PRAGMA data_version`, which changes only when another connection commits and
 * reads no table pages, plus this connection's own write count. One watcher per
 * process is enough; the timer is unref'd so it never keeps a process alive.
 */
export function watchChanges(
	shipmates: Shipmates,
	onChange: () => void,
	opts: {intervalMs?: number} = {},
): {stop(): void} {
	let last = shipmates.changeToken();
	const timer = setInterval(() => {
		let token: string;
		try {
			token = shipmates.changeToken();
		} catch {
			return; // closed underneath us; stop() is on its way
		}
		if (token === last) return;
		last = token;
		try {
			onChange();
		} catch (e) {
			console.error('[shipmates] change handler failed:', e);
		}
	}, opts.intervalMs ?? 1000);
	timer.unref();
	return {stop: () => clearInterval(timer)};
}
