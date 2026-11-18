import type {Kenning} from './kenning.js';

/**
 * Call `onChange` whenever anything in the database changed (D6). It polls
 * `PRAGMA data_version`, which changes only when another connection commits and
 * reads no table pages, plus this connection's own write count. One watcher per
 * process is enough; the timer is unref'd so it never keeps a process alive.
 */
export function watchChanges(
	kenning: Kenning,
	onChange: () => void,
	opts: {intervalMs?: number} = {},
): {stop(): void} {
	let last = kenning.changeToken();
	const timer = setInterval(() => {
		let token: string;
		try {
			token = kenning.changeToken();
		} catch {
			return; // closed underneath us; stop() is on its way
		}
		if (token === last) return;
		last = token;
		try {
			onChange();
		} catch (e) {
			console.error('[kenning] change handler failed:', e);
		}
	}, opts.intervalMs ?? 1000);
	timer.unref();
	return {stop: () => clearInterval(timer)};
}
