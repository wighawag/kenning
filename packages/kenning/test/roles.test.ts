import {describe, expect, it} from 'vitest';
import {A, B, C, world} from './helpers.js';

function three() {
	const w = world();
	const p1 = w.open(1);
	const p2 = w.open(2);
	p1.k.register({sessionFile: A, sessionId: 'aaaa1111', cwd: '/r/push'});
	p2.k.register({sessionFile: B, sessionId: 'bbbb2222', cwd: '/r/missiv'});
	return {w, p1, p2};
}

describe('roles', () => {
	it('a free role is claimed, and lists filter by it', () => {
		const {p1} = three();
		expect(p1.k.claimRole(A, 'template-tree/push')).toMatchObject({ok: true});
		expect(
			p1.k.list({role: 'template-tree/push'}).map((p) => p.sessionFile),
		).toEqual([A]);
	});

	it('a live holder keeps its role unless the claim says takeover', () => {
		const {p1, p2} = three();
		p1.k.claimRole(A, 'template-tree/push');
		expect(p2.k.claimRole(B, 'template-tree/push')).toMatchObject({
			ok: false,
			holder: A,
		});
		expect(
			p2.k.claimRole(B, 'template-tree/push', {takeover: true}),
		).toMatchObject({ok: true, previous: A});
		expect(p1.k.presence(A)!.roles).toEqual([]);
		// The old holder is told, through its own mailbox.
		const notices = p1.k.pendingFor(A);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toMatchObject({kind: 'notice', origin: 'agent'});
		expect(notices[0].text).toContain('template-tree/push');
	});

	it('the newest claim wins when the holder is gone: a restart takes over the address', () => {
		const {p1, p2} = three();
		p1.k.claimRole(A, 'template-tree/push');
		p2.probe.dead.add(1);
		expect(p2.k.claimRole(B, 'template-tree/push')).toMatchObject({
			ok: true,
			previous: A,
		});
	});

	it('refuses a malformed role', () => {
		const {p1} = three();
		expect(() => p1.k.claimRole(A, 'Push Lane!')).toThrow(/role/);
	});
});

describe('resolve', () => {
	it('a .jsonl string is a session, then an exact role, then a unique session-id prefix', () => {
		const {p1} = three();
		p1.k.claimRole(A, 'template-tree/push');
		expect(p1.k.resolve(B)).toEqual({kind: 'session', target: B, session: B});
		expect(p1.k.resolve('template-tree/push')).toEqual({
			kind: 'role',
			target: 'template-tree/push',
			session: A,
		});
		expect(p1.k.resolve('bbbb')).toEqual({
			kind: 'session',
			target: B,
			session: B,
		});
	});

	it('an ambiguous prefix is an error listing the candidates', () => {
		const {w, p1} = three();
		w.open(3).k.register({
			sessionFile: C,
			sessionId: 'bbbb3333',
			cwd: '/r/triggers',
		});
		expect(() => p1.k.resolve('bbbb')).toThrow(
			/ambiguous.*b\.jsonl.*c\.jsonl|ambiguous.*c\.jsonl.*b\.jsonl/s,
		);
	});

	it('a role nobody holds still resolves, so a message can wait for its next holder', () => {
		const {p1} = three();
		expect(p1.k.resolve('template-tree/triggers')).toEqual({
			kind: 'role',
			target: 'template-tree/triggers',
			session: null,
		});
		expect(() => p1.k.resolve('nonsense-without-slash')).toThrow(/no session/);
	});
});
