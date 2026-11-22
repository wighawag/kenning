import {describe, expect, it} from 'vitest';
import {planDelivery, type SessionView} from '../src/index.js';

const settled: SessionView = {
	phase: 'settled',
	declared: 'idle',
	uiPrompt: false,
	editorBusy: false,
	wake: true,
};
const running: SessionView = {
	...settled,
	phase: 'running',
	declared: 'running',
};

describe('planDelivery', () => {
	it('a running session reads a message before it settles, or after the current tool batch when urgent', () => {
		expect(planDelivery(running, {urgent: false})).toBe('at-settle');
		expect(planDelivery(running, {urgent: true})).toBe('at-turn-end');
	});

	it('an idle session is woken', () => {
		expect(planDelivery(settled, {urgent: false})).toBe('wake');
	});

	it("a session waiting for the human holds the message for the human's next turn", () => {
		expect(
			planDelivery({...settled, declared: 'waiting-for-human'}, {urgent: true}),
		).toBe('hold-for-human');
	});

	it('a session waiting for the human wakes for the human (an inbox answer), and only for them', () => {
		const waiting = {...settled, declared: 'waiting-for-human' as const};
		expect(planDelivery(waiting, {urgent: false, fromHuman: true})).toBe(
			'wake',
		);
		expect(planDelivery(waiting, {urgent: true, fromHuman: false})).toBe(
			'hold-for-human',
		);
		// The human typing into the session, or waking off, still holds it.
		expect(
			planDelivery(
				{...waiting, editorBusy: true},
				{urgent: false, fromHuman: true},
			),
		).toBe('hold-for-human');
		expect(
			planDelivery({...waiting, wake: false}, {urgent: false, fromHuman: true}),
		).toBe('hold-for-human');
	});

	it('never wakes a session while the human is typing in it, or when waking is off', () => {
		expect(planDelivery({...settled, editorBusy: true}, {urgent: false})).toBe(
			'hold-for-human',
		);
		expect(planDelivery({...settled, wake: false}, {urgent: true})).toBe(
			'hold-for-human',
		);
	});

	it('a session in a dialog with the human gets it after the dialog, at the turn end', () => {
		expect(planDelivery({...running, uiPrompt: true}, {urgent: false})).toBe(
			'at-turn-end',
		);
	});
});
