import {describe, expect, it} from 'vitest';
import {A, B, world} from './helpers.js';

const DAY = 86_400_000;

describe('retention', () => {
	it('finished messages, questions and items go after 30 days; pending ones never do', () => {
		const w = world();
		const {k} = w.open(1);
		k.register({sessionFile: A, cwd: '/r'});
		k.register({sessionFile: B, cwd: '/r'});
		const done = k.send({from: A, to: B, text: 'delivered one'});
		k.markDelivered(
			B,
			k.claim(B).map((m) => m.id),
		);
		const waiting = k.send({from: A, to: B, kind: 'ask', text: 'still open'});
		const item = k.humanAsk({from: A, question: 'answered'});
		k.answerItem(item.id, 'ok', {channel: 'cli'});
		w.advance(31 * DAY);
		k.prune();
		expect(k.message(done.message.id)).toBeNull();
		expect(k.item(item.id)).toBeNull();
		expect(k.message(waiting.message.id)).toMatchObject({state: 'pending'});
		expect(k.question(waiting.question!.id)).toMatchObject({state: 'open'});
	});

	it('the presence of a dead process goes after a day', () => {
		const w = world();
		const one = w.open(1);
		const two = w.open(2);
		two.k.register({sessionFile: B, cwd: '/r'});
		one.probe.dead.add(2);
		one.k.prune();
		expect(one.k.list({includeGone: true})).toHaveLength(1);
		w.advance(DAY + 1);
		one.k.prune();
		expect(one.k.list({includeGone: true})).toEqual([]);
	});

	it('pruneIfDue runs at most once a day', () => {
		const w = world();
		const {k} = w.open(1);
		expect(k.pruneIfDue()).toBe(true);
		expect(k.pruneIfDue()).toBe(false);
		w.advance(DAY + 1);
		expect(k.pruneIfDue()).toBe(true);
	});
});
