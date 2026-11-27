export type SessionState =
	'running' | 'waiting-for-human' | 'waiting-for-session' | 'idle';
export type Origin = 'human' | 'agent' | 'human-relayed';
/** `spawn`: the first prompt of a session another session spawned, from its owner (D28). */
export type MessageKind = 'tell' | 'ask' | 'answer' | 'notice' | 'spawn';
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
	/** Whether a message may start a turn here (`/shipmates wake off` clears it). */
	wake: boolean;
	/**
	 * It declared `waiting-for-human` (ADR 0006) and has not run since. Like
	 * `wake`, kept per transcript file across an unload or a resume (D40).
	 */
	declaredWaiting: boolean;
	/** False once the process that registered it is gone. */
	live: boolean;
	pid: number;
	updatedAt: number;
	/** Last time it became idle or waiting for the human. */
	settledAt: number | null;
}

/**
 * What a session chose for itself, kept per transcript file whether or not it
 * is live (D40): `/shipmates wake off`, and a declared `waiting-for-human`
 * with no run since. `updatedAt` is null for a session that set nothing.
 */
export interface SessionSetting {
	sessionFile: string;
	wake: boolean;
	declaredWaiting: boolean;
	updatedAt: number | null;
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

/**
 * The `answerChannel` of an item the human answered by replying in the asking
 * session's own conversation rather than in an inbox (D39).
 */
export const SESSION_ANSWER_CHANNEL = 'session';

export interface AttentionItem {
	id: string;
	session: string;
	question: string;
	options: string[] | null;
	blocking: boolean;
	onBehalfOf: string[];
	state: 'open' | 'answered' | 'withdrawn';
	answer: string | null;
	/**
	 * Where the human answered: `terminal` (a TUI dialog or `/shipmates inbox`),
	 * `cli`, a host's own channel (`web`, `telegram`), or `session` when the
	 * human replied in the asking session's own conversation (D39).
	 */
	answerChannel: string | null;
	createdAt: number;
	/** When it was answered or withdrawn; null while open. */
	finishedAt: number | null;
}

/** How a session came to be owned (D23): through a host, or the terminal default (D19). */
export type SpawnVia = 'host' | 'zellij' | 'headless' | 'recorded';

/**
 * Who spawned a session (D23). Set once, when the spawned session exists, and
 * never changed; it outlives presence, so a child that is not live is still owned.
 */
export interface Ownership {
	/** The spawn (`sp_...`), known before the session exists. */
	id: string;
	/** Null until the new session exists and is bound to this spawn. */
	session: string | null;
	owner: string;
	folder: string;
	role: string | null;
	via: SpawnVia;
	/** How it was spawned beyond `via`: fork, worktree, host name. */
	detail: Record<string, unknown>;
	createdAt: number;
	boundAt: number | null;
	archived: ArchiveMark | null;
}

/** A host archived or deleted a session (D24); undoable until `undoUntil`. */
export interface ArchiveMark {
	session: string;
	kind: 'archived' | 'deleted';
	/** One archive call and its whole cascade; the unit of undo. */
	batch: string;
	by: string;
	at: number;
	undoUntil: number;
}

/** A request to stop a session's current turn (D30). */
export interface StopRequest {
	id: string;
	session: string;
	by: string | null;
	byLabel: string;
	at: number;
	handledAt: number | null;
	outcome: 'stopped' | 'not-running' | null;
}

export class ShipmatesError extends Error {
	constructor(
		message: string,
		readonly code: string,
		readonly details?: unknown,
	) {
		super(message);
		this.name = 'ShipmatesError';
	}
}
