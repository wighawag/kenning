import {describe, expect, it} from 'vitest';
import {
	formatStatusFacts,
	runCli,
	SESSION_ANSWER_CHANNEL,
} from '../src/index.js';
import {A, B, world} from './helpers.js';

// The 2026-11-28 case: a lane raised a non-blocking item and said so in its
// status; the human answered on Telegram while the lane was in one long run, so
// the answer stayed pending and the status kept saying "pending human h_...".
// A reader must be able to tell, from shipmates, what the status cannot.
function lanes() {
	const w = world();
	const cascade = w.open(1);
	const orchestrator = w.open(2);
	cascade.k.register({sessionFile: A, sessionId: 'a1', cwd: '/r/cascade'});
	orchestrator.k.register({sessionFile: B, sessionId: 'b1', cwd: '/r/conq'});
	return {w, cascade, orchestrator};
}

describe('status facts (D41)', () => {
	it('an open item is outstanding; once answered it stays outstanding until its session has read the answer', () => {
		const {cascade, orchestrator} = lanes();
		const item = cascade.k.humanAsk({from: A, question: 'Skip voxlings?'});
		expect(
			orchestrator.k.outstandingItems(A).map((i) => [i.id, i.state]),
		).toEqual([[item.id, 'open']]);

		const answer = orchestrator.k.answerItem(item.id, 'Skip voxlings', {
			channel: 'telegram',
		});
		const [unread] = orchestrator.k.outstandingItems(A);
		expect(unread).toMatchObject({
			id: item.id,
			state: 'answered',
			answerChannel: 'telegram',
			answerPending: true,
		});
		expect(orchestrator.k.itemStatus(item.id)!.answerPending).toBe(true);

		cascade.k.markDelivered(A, [answer.id]);
		expect(orchestrator.k.outstandingItems(A)).toEqual([]);
		expect(orchestrator.k.itemStatus(item.id)!.answerPending).toBe(false);
	});

	it('flags the ids a status names once they are no longer open, saying whether the asker has read the answer', () => {
		const {cascade, orchestrator, w} = lanes();
		const item = cascade.k.humanAsk({from: A, question: 'Skip voxlings?'});
		const status = `verify green; voxlings held pending human ${item.id}; nothing pushed`;
		cascade.k.update(A, {status});
		// Still open: nothing to flag, and the item shows as open.
		expect(orchestrator.k.statusFacts(A).stale).toEqual([]);

		w.advance(4 * 60_000);
		const answer = orchestrator.k.answerItem(item.id, 'Skip voxlings', {
			channel: 'telegram',
		});
		const facts = orchestrator.k.statusFacts(A);
		expect(facts.stale).toEqual([
			{
				kind: 'item',
				id: item.id,
				state: 'answered',
				at: Date.parse('2026-11-17T10:04:00Z'),
				channel: 'telegram',
				own: true,
				answerPending: true,
			},
		]);
		const lines = formatStatusFacts(facts).join('\n');
		expect(lines).toContain(
			`${item.id} answered by the human 2026-11-17T10:04Z on telegram, answer not yet delivered to this session`,
		);
		expect(lines).toContain(
			`its inbox items: ${item.id} answered 2026-11-17T10:04Z on telegram, answer not yet delivered`,
		);

		cascade.k.markDelivered(A, [answer.id]);
		expect(formatStatusFacts(orchestrator.k.statusFacts(A)).join('\n')).toBe(
			`status names: ${item.id} answered by the human 2026-11-17T10:04Z on telegram, answer read by this session`,
		);
	});

	it("an answer in the session's own turn is read at once; a withdrawn item, a question and an unknown id are flagged too", () => {
		const {cascade, orchestrator} = lanes();
		const inTurn = cascade.k.humanAsk({from: A, question: 'Branch?'});
		cascade.k.answerItem(inTurn.id, 'main', {
			channel: SESSION_ANSWER_CHANNEL,
			deliver: false,
		});
		const gone = cascade.k.humanAsk({from: A, question: 'Still needed?'});
		cascade.k.withdrawItem(A, gone.id);
		const q = orchestrator.k.send({
			from: B,
			to: A,
			kind: 'ask',
			text: 'MIT?',
		}).question!;
		cascade.k.answer({from: A, questionId: q.id, text: 'AGPL'});
		const other = orchestrator.k.humanAsk({from: B, question: 'Ship?'});
		orchestrator.k.answerItem(other.id, 'yes', {channel: 'web'});

		cascade.k.update(A, {
			status: `${inTurn.id} ${gone.id} ${q.id} h_AAAAAAAA ${other.id} again ${inTurn.id}`,
		});
		const {stale, items} = orchestrator.k.statusFacts(A);
		expect(items).toEqual([]);
		expect(stale.map((r) => [r.id, r.state])).toEqual([
			[inTurn.id, 'answered'],
			[gone.id, 'withdrawn'],
			[q.id, 'answered'],
			['h_AAAAAAAA', 'unknown'],
			[other.id, 'answered'],
		]);
		expect(stale[0]).toMatchObject({own: true, answerPending: false});
		// Another session's item: its answer is pending to the session that asked.
		expect(stale[4]).toMatchObject({own: false, answerPending: true});
		const text = formatStatusFacts({stale, items}).join('\n');
		expect(text).toContain(
			`${other.id} answered by the human 2026-11-17T10:00Z on web, answer not yet delivered to the session that asked`,
		);
		expect(text).toContain('h_AAAAAAAA: no such inbox item');
	});

	it('the CLI shows them beside the status, for the human too', () => {
		const {cascade, orchestrator, w} = lanes();
		const item = cascade.k.humanAsk({from: A, question: 'Skip voxlings?'});
		cascade.k.update(A, {status: `voxlings held pending human ${item.id}`});
		orchestrator.k.answerItem(item.id, 'Skip voxlings', {channel: 'telegram'});
		let out = '';
		runCli(['read', A], {
			env: {SHIPMATES_STATE_DIR: w.stateDir},
			isTTY: true,
			stdout: (s) => (out += s),
			stderr: () => {},
		});
		expect(out).toContain(
			`status names: ${item.id} answered by the human 2026-11-17T10:00Z on telegram, answer not yet delivered to this session (the status is its own words and may lag)`,
		);
	});

	it('a session that is gone still shows what the human owes it', () => {
		// A headless child whose human_ask timed out and exited, a session a host
		// unloaded: presence is gone, the items are not.
		const {cascade, orchestrator, w} = lanes();
		const item = cascade.k.humanAsk({from: A, question: 'Skip voxlings?'});
		cascade.k.unregister(A);
		expect(orchestrator.k.presence(A)).toBeNull();
		expect(orchestrator.k.statusFacts(A, null).items.map((i) => i.id)).toEqual([
			item.id,
		]);
		let out = '';
		runCli(['read', A], {
			env: {SHIPMATES_STATE_DIR: w.stateDir},
			isTTY: true,
			stdout: (s) => (out += s),
			stderr: () => {},
		});
		expect(out).toContain(`its inbox items: ${item.id} open, asked`);
	});
});
