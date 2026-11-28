import type {SessionState} from './types.js';

/** What a host knows about a session at the moment a message could be delivered. */
export interface SessionView {
	/** pi's view: a run is in progress, or the session has settled. */
	phase: 'running' | 'settled';
	/** What the session declared (ADR 0006); only `waiting-for-human` changes the plan. */
	declared: SessionState;
	/** A blocking dialog with the human is open (`ui_prompt_start`). */
	uiPrompt: boolean;
	/** The human has text in the editor: they are typing into this session. */
	editorBusy: boolean;
	/** `/shipmates wake off` turns waking off for this session. */
	wake: boolean;
}

/**
 * When a message enters a session (ADR 0002). Nothing goes into pi's own
 * queues, so every plan except `wake` keeps the message in shipmates until the
 * boundary, where it can still be superseded or withdrawn:
 * - `at-settle`: returned from `agent_before_settle` with a continuation;
 * - `at-turn-end`: returned from `turn_end` (urgent, or after a dialog);
 * - `wake`: start a turn now (`sendMessage` with `triggerTurn`);
 * - `hold-for-human`: attached to the human's next run by `before_agent_start`.
 *
 * `fromHuman`: a pending message has origin `human` (an inbox answer, the
 * human's `shipmates tell`), which only a human act can produce (ADR 0003). A
 * session that declared `waiting-for-human` is waiting for exactly that, so it
 * wakes for it: holding it for "the human's next turn" meant an answer given
 * from the inbox (or a host such as wherever) sat there until the human also
 * typed into the session, which they had no reason to do. Still held while the
 * human types into the session (it joins that run) or with waking off.
 *
 * A running session gets the human's message at the next turn end, as if it
 * were urgent (D41): `human_ask` with `blocking: false` tells the agent to go
 * on working and that the answer arrives as a message, and at `at-settle` it
 * arrived only once that work was over. On 2026-11-28 an answer given at 11:23
 * was still pending an hour later, in one long run, while the session's status
 * said, truthfully for what it knew, that it was waiting for the human.
 */
export type DeliveryPlan =
	'at-settle' | 'at-turn-end' | 'wake' | 'hold-for-human';

export function planDelivery(
	view: SessionView,
	message: {urgent: boolean; fromHuman?: boolean},
): DeliveryPlan {
	if (view.phase === 'running') {
		if (view.uiPrompt) return 'at-turn-end';
		return message.urgent || message.fromHuman ? 'at-turn-end' : 'at-settle';
	}
	if (view.editorBusy || !view.wake) return 'hold-for-human';
	if (view.declared === 'waiting-for-human' && !message.fromHuman)
		return 'hold-for-human';
	return 'wake';
}
