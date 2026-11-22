import {describe, expect, it} from 'vitest';
import {A, B, world} from './helpers.js';

describe('presence', () => {
	it('lists the sessions that registered and are still running', () => {
		const w = world();
		const {k} = w.open(1);
		k.register({sessionFile: A, sessionId: 'a', cwd: '/r/push'});
		k.register({sessionFile: B, sessionId: 'b', cwd: '/r/missiv'});
		expect(
			k
				.list()
				.map((p) => p.sessionFile)
				.sort(),
		).toEqual([B, A].sort());
		expect(k.list({cwd: '/r/push'}).map((p) => p.sessionFile)).toEqual([A]);
	});

	it('drops a session whose process died, with no heartbeat needed', () => {
		const w = world();
		const one = w.open(1);
		const two = w.open(2);
		one.k.register({sessionFile: A, sessionId: 'a', cwd: '/r/push'});
		two.k.register({sessionFile: B, sessionId: 'b', cwd: '/r/missiv'});
		one.probe.dead.add(2);
		expect(one.k.list().map((p) => p.sessionFile)).toEqual([A]);
		expect(one.k.list({includeGone: true}).map((p) => p.live)).toEqual(
			expect.arrayContaining([true, false]),
		);
	});

	it('records state, status and refs the session declares', () => {
		const w = world();
		const {k} = w.open(1);
		k.register({sessionFile: A, sessionId: 'a', cwd: '/r/push'});
		k.update(A, {
			state: 'running',
			status: 'building S1',
			refs: ['origin/work 31f6c74f'],
		});
		expect(k.list()[0]).toMatchObject({
			state: 'running',
			status: 'building S1',
			refs: ['origin/work 31f6c74f'],
		});
		k.unregister(A);
		expect(k.list()).toEqual([]);
	});
});
