import {describe, expect, it} from 'vitest';
import {A, B, C, world} from './helpers.js';

function lanes() {
	const w = world();
	const push = w.open(1);
	const missiv = w.open(2);
	push.k.register({sessionFile: A, sessionId: 'a1', cwd: '/r/push'});
	missiv.k.register({sessionFile: B, sessionId: 'b1', cwd: '/r/missiv'});
	push.k.claimRole(A, 'template-tree/push');
	missiv.k.claimRole(B, 'template-tree/messaging');
	return {w, push, missiv};
}

describe('send', () => {
	it('delivers to the target and shows the sender what it is talking to', () => {
		const {push, missiv} = lanes();
		missiv.k.update(B, {
			state: 'waiting-for-human',
			status: 'S3 review: waiting for answers',
		});
		const sent = push.k.send({
			from: A,
			to: 'template-tree/messaging',
			text: 'missiv origin/main is f357d11',
		});
		expect(sent.duplicate).toBe(false);
		expect(sent.message).toMatchObject({
			fromLabel: 'template-tree/push',
			origin: 'agent',
			state: 'pending',
			kind: 'tell',
		});
		expect(sent.target).toMatchObject({
			sessionFile: B,
			state: 'waiting-for-human',
			status: 'S3 review: waiting for answers',
		});
		expect(missiv.k.pendingFor(B).map((m) => m.text)).toEqual([
			'missiv origin/main is f357d11',
		]);
	});

	it('a retry with the same requestId does not send twice', () => {
		const {push, missiv} = lanes();
		const one = push.k.send({from: A, to: B, text: 'x', requestId: 'call-7'});
		const two = push.k.send({from: A, to: B, text: 'x', requestId: 'call-7'});
		expect(two.duplicate).toBe(true);
		expect(two.message.id).toBe(one.message.id);
		expect(missiv.k.pendingFor(B)).toHaveLength(1);
	});

	it('refuses text over 8 KB: content belongs in git, the message points at it', () => {
		const {push} = lanes();
		expect(() =>
			push.k.send({from: A, to: B, text: 'x'.repeat(8 * 1024 + 1)}),
		).toThrow(/8 KB/);
	});

	it('human-relayed needs the human words it carries', () => {
		const {push} = lanes();
		expect(() =>
			push.k.send({
				from: A,
				to: B,
				text: 'they approve',
				origin: 'human-relayed',
			}),
		).toThrow(/relay/);
	});
});

describe('delivery', () => {
	it('a message is claimed by one process only, and is gone once delivered', () => {
		const {w, missiv} = lanes();
		const other = w.open(3); // the same session opened by a second process
		lanesSend(missiv.k);
		const first = missiv.k.claim(B);
		expect(first).toHaveLength(1);
		expect(other.k.claim(B)).toEqual([]);
		missiv.k.markDelivered(
			B,
			first.map((m) => m.id),
		);
		expect(missiv.k.message(first[0].id)).toMatchObject({
			state: 'delivered',
			deliveredTo: B,
		});
		expect(missiv.k.pendingFor(B)).toEqual([]);
	});

	it('a claim whose process died, or whose lease expired, can be taken again', () => {
		const {w, missiv} = lanes();
		const other = w.open(3);
		lanesSend(missiv.k);
		missiv.k.claim(B);
		other.probe.dead.add(2);
		expect(other.k.claim(B)).toHaveLength(1);
		other.probe.dead.clear();
		w.advance(61_000);
		expect(missiv.k.claim(B)).toHaveLength(1);
	});

	it('a message to a role waits for the next holder', () => {
		const {w, push} = lanes();
		const sent = push.k.send({
			from: A,
			to: 'template-tree/triggers',
			text: 'treat 409 as retryable',
		});
		expect(sent.target).toBeNull();
		const triggers = w.open(4);
		triggers.k.register({sessionFile: C, sessionId: 'c1', cwd: '/r/triggers'});
		expect(triggers.k.pendingFor(C)).toEqual([]);
		triggers.k.claimRole(C, 'template-tree/triggers');
		expect(triggers.k.pendingFor(C).map((m) => m.text)).toEqual([
			'treat 409 as retryable',
		]);
	});
});

describe('supersede and withdraw', () => {
	it('replace a message that is not delivered yet; the old one is never delivered', () => {
		const {push, missiv} = lanes();
		const old = push.k.send({
			from: A,
			to: B,
			text: 'missiv-identity 0.1.0 is published',
		});
		const replaced = push.k.supersede(
			A,
			old.message.id,
			'missiv-identity 0.2.0 is published; 0.1.0 is superseded',
		);
		expect(push.k.message(old.message.id)).toMatchObject({
			state: 'superseded',
			supersededBy: replaced.id,
		});
		expect(missiv.k.pendingFor(B).map((m) => m.text)).toEqual([
			'missiv-identity 0.2.0 is published; 0.1.0 is superseded',
		]);
		push.k.withdraw(A, replaced.id);
		expect(missiv.k.pendingFor(B)).toEqual([]);
	});

	it("cannot change a delivered message, nor someone else's", () => {
		const {push, missiv} = lanes();
		const sent = push.k.send({from: A, to: B, text: 'x'});
		expect(() => missiv.k.withdraw(B, sent.message.id)).toThrow(/not yours/);
		missiv.k.markDelivered(
			B,
			missiv.k.claim(B).map((m) => m.id),
		);
		expect(() => push.k.supersede(A, sent.message.id, 'y')).toThrow(
			/delivered/,
		);
	});
});

function lanesSend(k: import('../src/index.js').Kenning) {
	k.send({from: A, to: B, text: 'hello'});
}

describe('claiming twice', () => {
	it('a process never gets back a message it is already delivering, until it releases it', () => {
		const {missiv} = lanes();
		missiv.k.send({from: A, to: B, text: 'once'});
		const first = missiv.k.claim(B);
		expect(first).toHaveLength(1);
		expect(missiv.k.claim(B)).toEqual([]);
		missiv.k.release(first.map((m) => m.id));
		expect(missiv.k.claim(B).map((m) => m.text)).toEqual(['once']);
	});
});
