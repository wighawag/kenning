import {describe, expect, it} from 'vitest';
import {SESSION_ANSWER_CHANNEL} from '../src/index.js';
import {A, B, world} from './helpers.js';

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

describe('questions', () => {
	it('stay open until the addressee answers; the answer goes back to the asker', () => {
		const {push, missiv} = lanes();
		const asked = push.k.send({
			from: A,
			to: 'template-tree/messaging',
			kind: 'ask',
			text: 'Does S3-6 need replay protection on GET?',
		});
		expect(asked.question).toMatchObject({
			state: 'open',
			askerLabel: 'template-tree/push',
		});
		expect(missiv.k.openQuestionsTo(B).map((q) => q.id)).toEqual([
			asked.question!.id,
		]);

		const answer = missiv.k.answer({
			from: B,
			questionId: asked.question!.id,
			text: 'No: GET is idempotent.',
		});
		expect(answer).toMatchObject({
			kind: 'answer',
			origin: 'agent',
			questionId: asked.question!.id,
		});
		expect(push.k.question(asked.question!.id)).toMatchObject({
			state: 'answered',
			answer: 'No: GET is idempotent.',
			answerOrigin: 'agent',
			answeredBy: B,
		});
		expect(push.k.pendingFor(A).map((m) => m.kind)).toEqual(['answer']);
		expect(() =>
			missiv.k.answer({from: B, questionId: asked.question!.id, text: 'again'}),
		).toThrow(/answered/);
	});

	it('only the session it was asked of can answer', () => {
		const {w, push} = lanes();
		const asked = push.k.send({
			from: A,
			to: 'template-tree/messaging',
			kind: 'ask',
			text: '?',
		});
		const stranger = w.open(9);
		expect(() =>
			stranger.k.answer({
				from: '/s/x.jsonl',
				questionId: asked.question!.id,
				text: 'yes',
			}),
		).toThrow(/not asked/);
	});

	it('withdrawing the message withdraws the question', () => {
		const {push, missiv} = lanes();
		const asked = push.k.send({from: A, to: B, kind: 'ask', text: '?'});
		push.k.withdraw(A, asked.message.id);
		expect(missiv.k.openQuestionsTo(B)).toEqual([]);
	});
});

describe('the human inbox', () => {
	it('an item waits in the inbox; the human answer comes back to its session as human input', () => {
		const {push} = lanes();
		const item = push.k.humanAsk({
			from: A,
			question: 'Publish missiv-identity 0.2.0? npm needs your 2FA.',
			options: ['done', 'not now'],
			blocking: true,
		});
		expect(push.k.inbox().map((i) => i.id)).toEqual([item.id]);
		const msg = push.k.answerItem(item.id, 'done', {channel: 'cli'});
		expect(msg).toMatchObject({
			kind: 'answer',
			origin: 'human',
			itemId: item.id,
		});
		expect(msg.relay).toMatchObject({
			text: 'done',
			channel: 'cli',
			itemId: item.id,
		});
		expect(push.k.inbox()).toEqual([]);
		expect(push.k.humanAnswers(A).map((i) => i.answer)).toEqual(['done']);
		expect(push.k.pendingFor(A).map((m) => m.text)).toEqual(['done']);
	});

	it("an orchestrator merges its children's questions into one item, keeping the links", () => {
		const {push, missiv} = lanes();
		const q = missiv.k.send({
			from: B,
			to: 'template-tree/push',
			kind: 'ask',
			text: 'MIT or AGPL for missiv-identity?',
		});
		const item = push.k.humanAsk({
			from: A,
			question: 'License for missiv-identity?',
			onBehalfOf: [q.question!.id],
		});
		expect(item.onBehalfOf).toEqual([q.question!.id]);
		expect(() =>
			push.k.humanAsk({from: A, question: 'x', onBehalfOf: ['q_nope']}),
		).toThrow(/q_nope/);
	});

	it("a reply in the asking session closes its open items, with no second copy of the human's words (D39)", () => {
		const {w, push, missiv} = lanes();
		const one = push.k.humanAsk({from: A, question: 'Branch?'});
		const two = push.k.humanAsk({from: A, question: 'Version?'});
		const other = missiv.k.humanAsk({from: B, question: 'License?'});
		const kept = push.k.humanAsk({from: A, question: 'Waited on'});
		w.advance(10);
		const closed = push.k.answerOpenItemsOf(A, 'main, 0.2.0', {
			channel: SESSION_ANSWER_CHANNEL,
			deliver: false,
			except: [kept.id],
		});
		expect(closed.map((i) => i.id)).toEqual([one.id, two.id]);
		for (const i of closed)
			expect(i).toMatchObject({
				state: 'answered',
				answer: 'main, 0.2.0',
				answerChannel: 'session',
				finishedAt: push.k.now(),
			});
		expect(push.k.pendingFor(A)).toEqual([]);
		expect(push.k.inbox().map((i) => i.id)).toEqual([other.id, kept.id]);
		// An item closed this way can still be relayed by an orchestrator.
		expect(push.k.relayFromHuman(A, {itemId: one.id})).toMatchObject({
			text: 'main, 0.2.0',
			channel: 'session',
		});
		expect(
			push.k.answerItem(kept.id, 'x', {channel: 'session', deliver: false}),
		).toBeNull();
		expect(push.k.pendingFor(A)).toEqual([]);
	});

	it('with notice, the session is told which items the reply closed, once', () => {
		const {push} = lanes();
		const one = push.k.humanAsk({from: A, question: 'Branch?'});
		const two = push.k.humanAsk({from: A, question: 'Version?'});
		push.k.answerOpenItemsOf(A, 'main', {
			channel: 'session',
			deliver: false,
			notice: true,
		});
		const pending = push.k.pendingFor(A);
		expect(pending).toHaveLength(1);
		expect(pending[0]).toMatchObject({kind: 'notice', origin: 'agent'});
		expect(pending[0].text).toContain(one.id);
		expect(pending[0].text).toContain(two.id);
		// Nothing open: no write, no notice.
		expect(
			push.k.answerOpenItemsOf(A, 'again', {channel: 'session', notice: true}),
		).toEqual([]);
		expect(push.k.pendingFor(A)).toHaveLength(1);
	});

	it('an item answered through one channel cannot be answered again through another', () => {
		const {push, missiv} = lanes();
		const item = push.k.humanAsk({from: A, question: 'Branch?'});
		push.k.answerItem(item.id, 'main', {channel: 'session', deliver: false});
		expect(() =>
			missiv.k.answerItem(item.id, 'dev', {channel: 'telegram'}),
		).toThrow(expect.objectContaining({code: 'answered'}));
		expect(push.k.item(item.id)).toMatchObject({
			answer: 'main',
			answerChannel: 'session',
		});
		expect(push.k.pendingFor(A)).toEqual([]);
	});

	it('only the session that raised an item can withdraw it', () => {
		const {push, missiv} = lanes();
		const item = push.k.humanAsk({from: A, question: 'Branch?'});
		expect(() => missiv.k.withdrawItem(B, item.id)).toThrow(/not by you/);
		expect(push.k.item(item.id)!.state).toBe('open');
		expect(push.k.withdrawItem(A, item.id).state).toBe('withdrawn');
		expect(() => push.k.withdrawItem(A, 'h_nope')).toThrow(/no item/);
	});

	it('a host can read which items closed since it last looked, and how', () => {
		const {w, push} = lanes();
		const a = push.k.humanAsk({from: A, question: 'a'});
		const b = push.k.humanAsk({from: A, question: 'b'});
		push.k.humanAsk({from: A, question: 'c'});
		w.advance(10);
		const since = push.k.now();
		push.k.answerItem(a.id, 'yes', {channel: 'web'});
		w.advance(10);
		push.k.withdrawItem(A, b.id);
		expect(
			push.k
				.itemsFinishedSince(since)
				.map((i) => [i.id, i.state, i.answerChannel]),
		).toEqual([
			[a.id, 'answered', 'web'],
			[b.id, 'withdrawn', null],
		]);
		expect(push.k.itemsFinishedSince(push.k.now() + 1)).toEqual([]);
	});
});

describe('human turns and relays', () => {
	it('a relay must quote a turn the human really typed, and carries the whole turn verbatim', () => {
		const {push, missiv} = lanes();
		push.k.recordHumanTurn(A, {
			text: '1. yes\n2. I approve the license change\n3. go',
			channel: 'terminal',
		});
		const relay = push.k.relayFromHuman(A, {quote: 'I approve the license'});
		expect(relay).toMatchObject({
			channel: 'terminal',
			session: A,
			text: '1. yes\n2. I approve the license change\n3. go',
		});
		const sent = push.k.send({
			from: A,
			to: B,
			text: 'The human approves the MIT license.',
			origin: 'human-relayed',
			relay,
		});
		expect(missiv.k.pendingFor(B)[0]).toMatchObject({
			origin: 'human-relayed',
			relay: {text: relay.text},
		});
		expect(sent.message.origin).toBe('human-relayed');
	});

	it('an agent cannot relay words the human never typed', () => {
		const {push} = lanes();
		push.k.recordHumanTurn(A, {
			text: 'looks good, keep going',
			channel: 'terminal',
		});
		expect(() => push.k.relayFromHuman(A, {quote: 'I approve'})).toThrow(
			/no human turn/,
		);
		expect(() => push.k.relayFromHuman(B, {})).toThrow(/no human turn/);
	});

	it('an answered inbox item can be relayed too', () => {
		const {push} = lanes();
		const item = push.k.humanAsk({from: A, question: 'MIT?'});
		push.k.answerItem(item.id, 'yes MIT', {channel: 'cli'});
		expect(push.k.relayFromHuman(A, {itemId: item.id})).toMatchObject({
			text: 'yes MIT',
			itemId: item.id,
		});
	});
});

describe('waitStatus (what session_wait returns on)', () => {
	it('keeps waiting, then reports the answer', () => {
		const {w, push, missiv} = lanes();
		const q = push.k.send({from: A, to: B, kind: 'ask', text: '?'}).question!;
		const start = push.k.now();
		missiv.k.update(B, {state: 'running'});
		w.advance(10);
		missiv.k.update(B, {status: 'still working'});
		expect(
			push.k.waitStatus({waiter: A, questionId: q.id, since: start}),
		).toBeNull();
		missiv.k.answer({from: B, questionId: q.id, text: 'yes'});
		expect(
			push.k.waitStatus({waiter: A, questionId: q.id, since: start}),
		).toMatchObject({status: 'answered', question: {answer: 'yes'}});
	});

	it('returns when the target settles without answering', () => {
		const {w, push, missiv} = lanes();
		const q = push.k.send({
			from: A,
			to: 'template-tree/messaging',
			kind: 'ask',
			text: '?',
		}).question!;
		const start = push.k.now();
		w.advance(10);
		missiv.k.update(B, {state: 'idle'});
		expect(
			push.k.waitStatus({waiter: A, questionId: q.id, since: start}),
		).toMatchObject({status: 'settled', target: {sessionFile: B}});
	});

	it('returns when someone asks the waiter, so two waiting sessions cannot deadlock', () => {
		const {w, push, missiv} = lanes();
		const q = push.k.send({
			from: A,
			to: B,
			kind: 'ask',
			text: 'A asks B',
		}).question!;
		const start = push.k.now();
		w.advance(10);
		missiv.k.send({from: B, to: A, kind: 'ask', text: 'B asks A'});
		expect(
			push.k.waitStatus({waiter: A, questionId: q.id, since: start}),
		).toMatchObject({status: 'asked', questions: [{text: 'B asks A'}]});
	});
});
