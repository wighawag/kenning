export type SessionState =
	'running' | 'waiting-for-human' | 'waiting-for-session' | 'idle';
export type Origin = 'human' | 'agent' | 'human-relayed';
export type MessageKind = 'tell' | 'ask' | 'answer' | 'notice';
export type MessageState = 'pending' | 'delivered' | 'superseded' | 'withdrawn';

export interface Presence {
	sessionFile: string;
	sessionId: string | null;
	cwd: string | null;
	branch: string | null;
	roles: string[];
	state: SessionState;
	status: string | null;
	refs: string[];
	waitingOn: string | null;
	/** Whether a message may start a turn here (`/kenning wake off` clears it). */
	wake: boolean;
	/** False once the process that registered it is gone. */
	live: boolean;
	pid: number;
	updatedAt: number;
	/** Last time it became idle or waiting for the human. */
	settledAt: number | null;
}

/** The human words a human-relayed message carries, verbatim, and where they were said. */
export interface Relay {
	text: string;
	channel: string;
	session: string | null;
	turnId?: string;
	itemId?: string;
	at: number;
}

export interface Message {
	id: string;
	from: string | null;
	fromLabel: string;
	to: {kind: 'session' | 'role'; target: string};
	kind: MessageKind;
	questionId: string | null;
	itemId: string | null;
	text: string;
	origin: Origin;
	relay: Relay | null;
	urgent: boolean;
	state: MessageState;
	supersededBy: string | null;
	deliveredTo: string | null;
	createdAt: number;
}

export interface Question {
	id: string;
	asker: string | null;
	askerLabel: string;
	messageId: string;
	to: {kind: 'session' | 'role'; target: string};
	text: string;
	state: 'open' | 'answered' | 'withdrawn';
	answer: string | null;
	answerOrigin: Origin | null;
	answerRelay: Relay | null;
	answeredBy: string | null;
	createdAt: number;
}

export interface AttentionItem {
	id: string;
	session: string;
	question: string;
	options: string[] | null;
	blocking: boolean;
	onBehalfOf: string[];
	state: 'open' | 'answered' | 'withdrawn';
	answer: string | null;
	answerChannel: string | null;
	createdAt: number;
}

export class KenningError extends Error {
	constructor(
		message: string,
		readonly code: string,
		readonly details?: unknown,
	) {
		super(message);
		this.name = 'KenningError';
	}
}
