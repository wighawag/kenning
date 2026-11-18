import {afterEach, describe, expect, it, vi} from 'vitest';
import type {KenningHost} from '../src/index.js';

type HostModule = typeof import('../src/host.js');

// Two copies of the module, as a host that bundled its own kenning would have:
// vi.resetModules() makes the second import evaluate host.ts afresh.
async function twoCopies(): Promise<[HostModule, HostModule]> {
	vi.resetModules();
	const one = await import('../src/host.js');
	vi.resetModules();
	const two = await import('../src/host.js');
	return [one, two];
}

const host = (name: string): KenningHost & {name: string} => ({
	name,
	async stop() {
		return 'not-mine';
	},
});

afterEach(() => {
	delete (globalThis as Record<symbol, unknown>)[Symbol.for('kenning.host')];
});

describe('the host registry', () => {
	it('is shared across two copies of the module', async () => {
		const [one, two] = await twoCopies();
		expect(one.registerHost).not.toBe(two.registerHost); // really two copies
		expect(two.currentHost()).toBeUndefined();
		const wherever = host('wherever');
		const off = one.registerHost(wherever);
		expect(two.currentHost()).toBe(wherever);
		off();
		expect(two.currentHost()).toBeUndefined();
	});

	it('the most recent registration wins; unregistering restores the previous one, in any order', async () => {
		const [one, two] = await twoCopies();
		const server = host('server');
		const bridge = host('bridge');
		const offServer = one.registerHost(server);
		const offBridge = two.registerHost(bridge);
		expect(one.currentHost()).toBe(bridge);
		offBridge();
		expect(one.currentHost()).toBe(server);
		const offBridge2 = two.registerHost(bridge);
		offServer(); // the older one goes first: the newer stays
		expect(two.currentHost()).toBe(bridge);
		offBridge2();
		offBridge2(); // idempotent
		expect(two.currentHost()).toBeUndefined();
	});

	it('uses the documented key, so a host can find it without importing kenning', async () => {
		const [one] = await twoCopies();
		const h = host('raw');
		one.registerHost(h);
		const raw = (globalThis as Record<symbol, any>)[Symbol.for('kenning.host')];
		expect(raw.version).toBe(1);
		expect(raw.entries.at(-1).host).toBe(h);
	});
});
