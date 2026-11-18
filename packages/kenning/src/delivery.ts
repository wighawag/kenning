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
	/** `/kenning wake off` turns waking off for this session. */
	wake: boolean;
}

/**
 * When a message enters a session (ADR 0002). Nothing goes into pi's own
 * queues, so every plan except `wake` keeps the message in kenning until the
 * boundary, where it can still be superseded or withdrawn:
 * - `at-settle`: returned from `agent_before_settle` with a continuation;
 * - `at-turn-end`: returned from `turn_end` (urgent, or after a dialog);
 * - `wake`: start a turn now (`sendMessage` with `triggerTurn`);
 * - `hold-for-human`: attached to the human's next run by `before_agent_start`.
 */
export type DeliveryPlan =
	'at-settle' | 'at-turn-end' | 'wake' | 'hold-for-human';

export function planDelivery(
	view: SessionView,
	message: {urgent: boolean},
): DeliveryPlan {
	if (view.phase === 'running') {
		if (view.uiPrompt) return 'at-turn-end';
		return message.urgent ? 'at-turn-end' : 'at-settle';
	}
	if (view.declared === 'waiting-for-human' || view.editorBusy || !view.wake)
		return 'hold-for-human';
	return 'wake';
}
