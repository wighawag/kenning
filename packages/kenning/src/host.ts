import type {DeliveryPlan} from './delivery.js';
import type {AttentionItem, Message} from './types.js';

/**
 * The event a host emits on a pi session's event bus (`pi.events`) right before
 * it sends a human's text into that session, so kenning records the turn as a
 * human act (ADR 0003, D22). Only extension code can reach the bus; the model
 * cannot. Emit it for web, Telegram or any authenticated human channel; never
 * for scheduled or agent-originated sends.
 */
export const HUMAN_INPUT_EVENT = 'kenning:human-input';

export interface HumanInputMark {
	text: string;
	/** Where the human typed it: `web`, `telegram`, ... */
	channel: string;
}

export interface SpawnRequest {
	owner: string;
	folder: string;
	prompt: string;
	role?: string;
	fork?: {sessionFile: string; entryId?: string};
	worktree?: {repo: string; branch: string};
}

/**
 * How a host delivers, notifies, spawns and stops (D20). The pi extension is the
 * default host for a terminal pi; wherever implements its own through its
 * session pool. Every member is optional: a host provides what it can.
 */
export interface KenningHost {
	/** Deliver messages into a session the host runs. 'held' leaves them pending. */
	deliver?(
		sessionFile: string,
		messages: Message[],
		plan: DeliveryPlan,
	): Promise<'done' | 'held'>;
	/** Tell the human about a new attention item (push, Telegram). */
	notifyHuman?(item: AttentionItem): Promise<void>;
	spawn?(req: SpawnRequest): Promise<{sessionFile: string}>;
	stop?(sessionFile: string): Promise<void>;
}
