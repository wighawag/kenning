import fs from 'node:fs';
import {defaultStateDir, openDb, write, type DB} from './store.js';
import {OsProbe, type ProcessIdentity, type ProcessProbe} from './liveness.js';
import {
	ShipmatesError,
	type ArchiveMark,
	type AttentionItem,
	type Message,
	type Ownership,
	type SpawnVia,
	type StopRequest,
	type Origin,
	type Presence,
	type Question,
	type Relay,
	type SessionSetting,
	type SessionState,
} from './types.js';
import {newId} from './ids.js';

export interface ShipmatesOptions {
	stateDir?: string;
	probe?: ProcessProbe;
	now?: () => number;
}

export interface RegisterInput {
	sessionFile: string;
	sessionId?: string | null;
	cwd?: string | null;
	branch?: string | null;
}

export interface PresencePatch {
	state?: SessionState;
	status?: string | null;
	refs?: string[];
	waitingOn?: string | null;
	branch?: string | null;
	cwd?: string | null;
	/** Kept per transcript file, across unregister and register (D40). */
	wake?: boolean;
	/**
	 * The session declared `waiting-for-human` (ADR 0006) and has not run since.
	 * Kept per transcript file like `wake`; `register` restores the state from it
	 * (D40). It does not set `state`: pass both.
	 */
	declaredWaiting?: boolean;
}

export interface ListFilter {
	cwd?: string;
	role?: string;
	state?: SessionState;
	includeGone?: boolean;
}

type PresenceRow = {
	session_file: string;
	session_id: string | null;
	cwd: string | null;
	branch: string | null;
	state: SessionState;
	status: string | null;
	refs: string | null;
	waiting_on: string | null;
	/** From session_setting (D40), not presence's own unused column. */
	s_wake: number;
	s_declared_waiting: number;
	pid: number;
	start_time: string | null;
	boot_id: string | null;
	host: string | null;
	updated_at: number;
	settled_at: number | null;
};

type SettingRow = {
	session_file: string;
	wake: number;
	declared_waiting: number;
	updated_at: number;
};

const toSetting = (r: SettingRow): SessionSetting => ({
	sessionFile: r.session_file,
	wake: r.wake === 1,
	declaredWaiting: r.declared_waiting === 1,
	updatedAt: r.updated_at,
});

/** Presence with the session's own settings (D40); a session with no row has the defaults. */
const PRESENCE_SELECT = `SELECT p.*, COALESCE(s.wake, 1) AS s_wake, COALESCE(s.declared_waiting, 0) AS s_declared_waiting
	 FROM presence p LEFT JOIN session_setting s ON s.session_file = p.session_file`;

/** D14: message text is short; content stays in git and messages point at it. */
const DAY = 86_400_000;

export const MAX_TEXT_BYTES = 8 * 1024;

/**
 * D24: an archive or delete cascade can be undone, as one batch, for 7 days. A
 * cascade from an orchestrator takes every lane with it, and an accidental one
 * is often noticed only after a weekend; until the window ends a host must not
 * remove a deleted session's transcript. Rejected: a seconds-long "undo" toast
 * (a cascade is noticed later than that) and 24 hours (shorter than a weekend).
 */
export const ARCHIVE_UNDO_MS = 7 * DAY;

export interface SpawnInput {
	owner: string;
	folder: string;
	/** The first prompt: delivered once, as a `spawn` message from the owner (D28). */
	prompt?: string | null;
	role?: string | null;
	via: SpawnVia;
	detail?: Record<string, unknown>;
}

type OwnershipRow = {
	id: string;
	session_file: string | null;
	owner: string;
	folder: string;
	role: string | null;
	via: SpawnVia;
	detail: string | null;
	prompt: string | null;
	created_at: number;
	bound_at: number | null;
	wake_until: number | null;
};

type ArchiveRow = {
	session_file: string;
	kind: ArchiveMark['kind'];
	batch: string;
	by_label: string;
	at: number;
};

type StopRow = {
	id: string;
	session_file: string;
	by_session: string | null;
	by_label: string;
	at: number;
	handled_at: number | null;
	outcome: StopRequest['outcome'];
};

const toArchive = (r: ArchiveRow): ArchiveMark => ({
	session: r.session_file,
	kind: r.kind,
	batch: r.batch,
	by: r.by_label,
	at: r.at,
	undoUntil: r.at + ARCHIVE_UNDO_MS,
});

const toStop = (r: StopRow): StopRequest => ({
	id: r.id,
	session: r.session_file,
	by: r.by_session,
	byLabel: r.by_label,
	at: r.at,
	handledAt: r.handled_at,
	outcome: r.outcome,
});

export interface SendInput {
	/** The sending session, or null for a human at the CLI. */
	from: string | null;
	fromLabel?: string;
	to: string;
	text: string;
	kind?: 'tell' | 'ask';
	origin?: Origin;
	relay?: Relay | null;
	requestId?: string | null;
	urgent?: boolean;
}

export interface SendResult {
	message: Message;
	question: Question | null;
	duplicate: boolean;
	/** The live session the message goes to, or null when nobody holds the role or the session is gone. */
	target: Presence | null;
	openQuestions: Question[];
}

type QuestionRow = {
	id: string;
	asker_session: string | null;
	asker_label: string;
	message_id: string;
	to_kind: 'session' | 'role';
	to_target: string;
	text: string;
	state: Question['state'];
	answer: string | null;
	answer_origin: Origin | null;
	answer_relay: string | null;
	answered_by: string | null;
	created_at: number;
};

function toQuestion(r: QuestionRow): Question {
	return {
		id: r.id,
		asker: r.asker_session,
		askerLabel: r.asker_label,
		messageId: r.message_id,
		to: {kind: r.to_kind, target: r.to_target},
		text: r.text,
		state: r.state,
		answer: r.answer,
		answerOrigin: r.answer_origin,
		answerRelay: r.answer_relay ? (JSON.parse(r.answer_relay) as Relay) : null,
		answeredBy: r.answered_by,
		createdAt: r.created_at,
	};
}

type ItemRow = {
	id: string;
	session_file: string;
	question: string;
	options: string | null;
	blocking: number;
	on_behalf_of: string | null;
	state: AttentionItem['state'];
	answer: string | null;
	answer_channel: string | null;
	created_at: number;
	finished_at: number | null;
};

function toItem(r: ItemRow): AttentionItem {
	return {
		id: r.id,
		session: r.session_file,
		question: r.question,
		options: r.options ? (JSON.parse(r.options) as string[]) : null,
		blocking: r.blocking === 1,
		onBehalfOf: r.on_behalf_of ? (JSON.parse(r.on_behalf_of) as string[]) : [],
		state: r.state,
		answer: r.answer,
		answerChannel: r.answer_channel,
		createdAt: r.created_at,
		finishedAt: r.finished_at,
	};
}

export type WaitStatus =
	| {status: 'answered'; question: Question}
	| {status: 'withdrawn'; question: Question}
	| {status: 'asked'; question: Question; questions: Question[]}
	| {status: 'settled'; question: Question; target: Presence};

export type Resolved = {
	kind: 'session' | 'role';
	target: string;
	session: string | null;
};

/** D8: lower-case words joined by `._:/-`, e.g. `template-tree/push` or `orchestrator:template-tree`. */
const ROLE_RE = /^[a-z0-9][a-z0-9._:/-]{0,79}$/;

type MessageRow = {
	id: string;
	from_session: string | null;
	from_label: string;
	to_kind: 'session' | 'role';
	to_target: string;
	kind: Message['kind'];
	question_id: string | null;
	item_id: string | null;
	text: string;
	origin: Origin;
	relay: string | null;
	urgent: number;
	state: Message['state'];
	superseded_by: string | null;
	delivered_to: string | null;
	claim_pid: number | null;
	claim_start: string | null;
	claim_until: number | null;
	created_at: number;
};

export class Shipmates {
	readonly db: DB;
	readonly probe: ProcessProbe;
	readonly now: () => number;
	private localWrites = 0;

	constructor(opts: ShipmatesOptions = {}) {
		this.db = openDb(opts.stateDir ?? defaultStateDir());
		this.probe = opts.probe ?? new OsProbe();
		this.now = opts.now ?? Date.now;
	}

	close(): void {
		this.db.close();
	}

	/** Changes whenever any connection (this one included) committed a write. */
	changeToken(): string {
		const row = this.db.prepare('PRAGMA data_version').get() as {
			data_version: number;
		};
		return `${row.data_version}:${this.localWrites}`;
	}

	protected tx<T>(fn: () => T): T {
		const out = write(this.db, fn);
		this.localWrites++;
		return out;
	}

	// ---------------------------------------------------------------- presence

	register(input: RegisterInput): Presence {
		const me = this.probe.self();
		const t = this.now();
		this.tx(() => {
			// A session that declared it waits for the human still does after an
			// unload or a resume: it has not run since (D40).
			const declared = this.db
				.prepare(
					`SELECT declared_waiting FROM session_setting WHERE session_file = ?`,
				)
				.get(input.sessionFile) as {declared_waiting: number} | undefined;
			const state: SessionState =
				declared?.declared_waiting === 1 ? 'waiting-for-human' : 'idle';
			this.db
				.prepare(
					`INSERT INTO presence(session_file, session_id, cwd, branch, state, pid, start_time, boot_id, host, registered_at, updated_at)
					 VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT(session_file) DO UPDATE SET
					   session_id = excluded.session_id, cwd = excluded.cwd,
					   branch = COALESCE(excluded.branch, presence.branch),
					   pid = excluded.pid, start_time = excluded.start_time, boot_id = excluded.boot_id,
					   host = excluded.host, updated_at = excluded.updated_at,
					   state = CASE WHEN presence.pid = excluded.pid THEN presence.state ELSE excluded.state END`,
				)
				.run(
					input.sessionFile,
					input.sessionId ?? null,
					input.cwd ?? null,
					input.branch ?? null,
					state,
					me.pid,
					me.startTime,
					me.bootId,
					me.host,
					t,
					t,
				);
		});
		return this.presence(input.sessionFile)!;
	}

	update(sessionFile: string, patch: PresencePatch): void {
		const sets: string[] = [];
		const vals: (string | number | null)[] = [];
		const put = (col: string, v: string | number | null) => {
			sets.push(`${col} = ?`);
			vals.push(v);
		};
		if (patch.state !== undefined) {
			put('state', patch.state);
			if (patch.state === 'idle' || patch.state === 'waiting-for-human')
				put('settled_at', this.now());
		}
		if (patch.status !== undefined) put('status', patch.status);
		if (patch.refs !== undefined) put('refs', JSON.stringify(patch.refs));
		if (patch.waitingOn !== undefined) put('waiting_on', patch.waitingOn);
		if (patch.branch !== undefined) put('branch', patch.branch);
		if (patch.cwd !== undefined) put('cwd', patch.cwd);
		put('updated_at', this.now());
		const setting =
			patch.wake !== undefined || patch.declaredWaiting !== undefined;
		this.tx(() => {
			this.db
				.prepare(
					`UPDATE presence SET ${sets.join(', ')} WHERE session_file = ?`,
				)
				.run(...vals, sessionFile);
			if (setting) this.writeSetting(sessionFile, patch);
		});
	}

	/**
	 * D40: the session's own choices, by transcript file. A row exists only while
	 * one differs from the default, so the table holds the few sessions that set
	 * something. Called inside a write.
	 */
	private writeSetting(
		sessionFile: string,
		patch: {wake?: boolean; declaredWaiting?: boolean},
	): void {
		const bit = (v: boolean | undefined) =>
			v === undefined ? null : v ? 1 : 0;
		this.db
			.prepare(
				`INSERT INTO session_setting(session_file, wake, declared_waiting, updated_at)
				 VALUES(?, COALESCE(?, 1), COALESCE(?, 0), ?)
				 ON CONFLICT(session_file) DO UPDATE SET
				   wake = COALESCE(?, wake), declared_waiting = COALESCE(?, declared_waiting),
				   updated_at = excluded.updated_at`,
			)
			.run(
				sessionFile,
				bit(patch.wake),
				bit(patch.declaredWaiting),
				this.now(),
				bit(patch.wake),
				bit(patch.declaredWaiting),
			);
		this.db
			.prepare(
				`DELETE FROM session_setting WHERE session_file = ? AND wake = 1 AND declared_waiting = 0`,
			)
			.run(sessionFile);
	}

	unregister(sessionFile: string): void {
		const me = this.probe.self();
		this.tx(() => {
			// Only the process that registered it may remove it: the same file can be
			// re-opened by another process (a resume elsewhere) before this one exits.
			this.db
				.prepare(`DELETE FROM presence WHERE session_file = ? AND pid = ?`)
				.run(sessionFile, me.pid);
		});
	}

	/**
	 * D40: every session whose own settings differ from the defaults, live or
	 * not, most recently changed first. A host uses it to show what a session
	 * that is not loaded chose (wherever's sidebar keeps "waiting for the human"
	 * for an unloaded session that declared it, which `list()` cannot show).
	 * Rows exist only for non-defaults, so this is the few that set something.
	 */
	settings(): SessionSetting[] {
		return (
			this.cached(
				`SELECT * FROM session_setting ORDER BY updated_at DESC, session_file`,
			).all() as SettingRow[]
		).map(toSetting);
	}

	/** D40: one session's settings; the defaults (`updatedAt` null) when it set none. */
	setting(sessionFile: string): SessionSetting {
		const row = this.cached(
			`SELECT * FROM session_setting WHERE session_file = ?`,
		).get(sessionFile) as SettingRow | undefined;
		return row
			? toSetting(row)
			: {sessionFile, wake: true, declaredWaiting: false, updatedAt: null};
	}

	presence(sessionFile: string): Presence | null {
		const row = this.db
			.prepare(`${PRESENCE_SELECT} WHERE p.session_file = ?`)
			.get(sessionFile) as PresenceRow | undefined;
		return row ? this.toPresence(row) : null;
	}

	isLive(sessionFile: string): boolean {
		return this.presence(sessionFile)?.live ?? false;
	}

	list(filter: ListFilter = {}): Presence[] {
		const rows = this.db
			.prepare(`${PRESENCE_SELECT} ORDER BY p.updated_at DESC`)
			.all() as PresenceRow[];
		return rows
			.map((r) => this.toPresence(r))
			.filter((p) => filter.includeGone || p.live)
			.filter((p) => !filter.cwd || p.cwd === filter.cwd)
			.filter((p) => !filter.state || p.state === filter.state)
			.filter((p) => !filter.role || p.roles.includes(filter.role));
	}

	// ------------------------------------------------------------------- roles

	claimRole(
		sessionFile: string,
		role: string,
		opts: {takeover?: boolean} = {},
	): {ok: true; previous: string | null} | {ok: false; holder: string} {
		if (!ROLE_RE.test(role))
			throw new ShipmatesError(
				`invalid role ${JSON.stringify(role)}: use lower-case words joined by . _ : / - (e.g. template-tree/push)`,
				'bad-role',
			);
		return this.tx(() => {
			const row = this.db
				.prepare(`SELECT session_file FROM role WHERE role = ?`)
				.get(role) as {session_file: string} | undefined;
			const holder = row?.session_file ?? null;
			if (holder === sessionFile) return {ok: true as const, previous: null};
			if (holder && this.isLive(holder) && !opts.takeover)
				return {ok: false as const, holder};
			this.db
				.prepare(
					`INSERT INTO role(role, session_file, claimed_at) VALUES(?, ?, ?)
					 ON CONFLICT(role) DO UPDATE SET session_file = excluded.session_file, claimed_at = excluded.claimed_at`,
				)
				.run(role, sessionFile, this.now());
			if (holder && this.isLive(holder))
				this.insertMessage({
					from: sessionFile,
					fromLabel: this.labelOf(sessionFile),
					to: {kind: 'session', target: holder},
					kind: 'notice',
					text: `shipmates: the role ${role} was taken over by ${sessionFile}. You no longer hold it; messages to ${role} now go there.`,
					origin: 'agent',
				});
			return {ok: true as const, previous: holder};
		});
	}

	releaseRole(sessionFile: string, role: string): void {
		this.tx(() => {
			this.db
				.prepare(`DELETE FROM role WHERE role = ? AND session_file = ?`)
				.run(role, sessionFile);
		});
	}

	roleHolder(role: string): string | null {
		const row = this.db
			.prepare(`SELECT session_file FROM role WHERE role = ?`)
			.get(role) as {session_file: string} | undefined;
		return row?.session_file ?? null;
	}

	/** D15: a `.jsonl` string is a session; else an exact role; else a unique session-id prefix. */
	resolve(target: string): Resolved {
		const t = target.trim();
		if (t.endsWith('.jsonl')) return {kind: 'session', target: t, session: t};
		const holder = this.roleHolder(t);
		if (holder) return {kind: 'role', target: t, session: holder};
		const matches = this.db
			.prepare(
				`SELECT session_file FROM presence WHERE session_id LIKE ? ESCAPE '\\'`,
			)
			.all(t.replace(/[\\%_]/g, (c) => '\\' + c) + '%') as {
			session_file: string;
		}[];
		if (matches.length === 1)
			return {
				kind: 'session',
				target: matches[0].session_file,
				session: matches[0].session_file,
			};
		if (matches.length > 1)
			throw new ShipmatesError(
				`ambiguous target ${JSON.stringify(t)}: ${matches.map((m) => m.session_file).join(', ')}`,
				'ambiguous',
				matches.map((m) => m.session_file),
			);
		// A role nobody holds yet still resolves (the message waits for its next
		// holder), but only when it looks like one, so a typo is not silently queued.
		if (ROLE_RE.test(t) && /[/:]/.test(t))
			return {kind: 'role', target: t, session: null};
		throw new ShipmatesError(
			`no session or role matches ${JSON.stringify(t)}`,
			'not-found',
		);
	}

	// ----------------------------------------------------------------- mailbox

	/**
	 * Send a message. The result carries the target's presence and open
	 * questions, so the sender sees what it is talking to (read before send).
	 * `requestId` makes a retried send a no-op (exactly once per sender).
	 */
	send(input: SendInput): SendResult {
		const text = input.text;
		if (!text.trim()) throw new ShipmatesError('a message needs text', 'empty');
		if (Buffer.byteLength(text) > MAX_TEXT_BYTES)
			throw new ShipmatesError(
				`message is over 8 KB (${Buffer.byteLength(text)} bytes): put the content in git (a branch, a commit, a plan section) and send a pointer to it`,
				'too-large',
			);
		const origin = input.origin ?? (input.from ? 'agent' : 'human');
		if (origin === 'human-relayed' && !input.relay)
			throw new ShipmatesError(
				'a human-relayed message must carry the relay (the human words and where they were said)',
				'no-relay',
			);
		const resolved = this.resolve(input.to);
		const fromLabel = input.fromLabel ?? this.labelOf(input.from);
		const kind = input.kind ?? 'tell';
		const out = this.tx(() => {
			if (input.requestId) {
				const dup = this.db
					.prepare(
						`SELECT * FROM message WHERE from_label = ? AND request_id = ?`,
					)
					.get(fromLabel, input.requestId) as MessageRow | undefined;
				if (dup) return {id: dup.id, duplicate: true};
			}
			const questionId = kind === 'ask' ? newId('q') : null;
			const id = this.insertMessage({
				from: input.from,
				fromLabel,
				to: {kind: resolved.kind, target: resolved.target},
				kind,
				text,
				origin,
				relay: input.relay ?? null,
				questionId,
				requestId: input.requestId ?? null,
				urgent: input.urgent,
			});
			if (questionId)
				this.db
					.prepare(
						`INSERT INTO question(id, asker_session, asker_label, message_id, to_kind, to_target, text, created_at)
						 VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
					)
					.run(
						questionId,
						input.from,
						fromLabel,
						id,
						resolved.kind,
						resolved.target,
						text,
						this.now(),
					);
			return {id, duplicate: false};
		});
		const message = this.message(out.id)!;
		const session =
			resolved.kind === 'role'
				? this.roleHolder(resolved.target)
				: resolved.session;
		const target = session ? this.presence(session) : null;
		return {
			message,
			question: message.questionId ? this.question(message.questionId) : null,
			duplicate: out.duplicate,
			target: target && target.live ? target : null,
			openQuestions: session ? this.openQuestionsTo(session) : [],
		};
	}

	/**
	 * Claim this session's deliverable messages for this process. A message is
	 * claimed by one process at a time (the same session file can be open in two),
	 * and a claim lapses when its process dies or its lease expires.
	 */
	claim(
		sessionFile: string,
		opts: {leaseMs?: number; ids?: string[]} = {},
	): Message[] {
		const me = this.probe.self();
		const until = this.now() + (opts.leaseMs ?? 60_000);
		// The poller calls this every second in every process: take the write lock
		// only when there is something to claim, or idle processes starve writers
		// (measured: four processes claiming in a loop pushed a writer past
		// busy_timeout).
		const claimable = (m: MessageRow) =>
			(!opts.ids || opts.ids.includes(m.id)) && !this.isClaimed(m);
		if (!this.pendingRows(sessionFile).some(claimable)) return [];
		return this.tx(() => {
			const claimed: Message[] = [];
			for (const m of this.pendingRows(sessionFile)) {
				if (!claimable(m)) continue;
				this.db
					.prepare(
						`UPDATE message SET claim_pid = ?, claim_start = ?, claim_until = ? WHERE id = ?`,
					)
					.run(me.pid, me.startTime, until, m.id);
				claimed.push(this.toMessage(m));
			}
			return claimed;
		});
	}

	/** Give claimed messages back (they were not injected after all). */
	release(ids: string[]): void {
		const me = this.probe.self();
		this.tx(() => {
			for (const id of ids)
				this.db
					.prepare(
						`UPDATE message SET claim_pid = NULL, claim_start = NULL, claim_until = NULL WHERE id = ? AND claim_pid = ?`,
					)
					.run(id, me.pid);
		});
	}

	/** The messages are in the receiver's transcript now. Idempotent. */
	markDelivered(sessionFile: string, ids: string[]): void {
		const t = this.now();
		this.tx(() => {
			for (const id of ids)
				this.db
					.prepare(
						`UPDATE message SET state = 'delivered', delivered_to = ?, finished_at = ?, claim_pid = NULL, claim_until = NULL
						 WHERE id = ? AND state = 'pending'`,
					)
					.run(sessionFile, t, id);
		});
	}

	supersede(from: string | null, id: string, text: string): Message {
		const old = this.ownPending(from, id);
		const sent = this.tx(() => {
			const newIdValue = this.insertMessage({
				from: old.from_session,
				fromLabel: old.from_label,
				to: {kind: old.to_kind, target: old.to_target},
				kind: old.kind,
				text,
				origin: old.origin,
				relay: old.relay ? (JSON.parse(old.relay) as Relay) : null,
				questionId: old.question_id,
				urgent: old.urgent === 1,
			});
			this.db
				.prepare(
					`UPDATE message SET state = 'superseded', superseded_by = ?, finished_at = ? WHERE id = ?`,
				)
				.run(newIdValue, this.now(), id);
			if (old.question_id)
				this.db
					.prepare(`UPDATE question SET message_id = ?, text = ? WHERE id = ?`)
					.run(newIdValue, text, old.question_id);
			return newIdValue;
		});
		return this.message(sent)!;
	}

	withdraw(from: string | null, id: string): void {
		const old = this.ownPending(from, id);
		this.tx(() => {
			this.db
				.prepare(
					`UPDATE message SET state = 'withdrawn', finished_at = ? WHERE id = ?`,
				)
				.run(this.now(), id);
			if (old.question_id)
				this.db
					.prepare(
						`UPDATE question SET state = 'withdrawn', finished_at = ? WHERE id = ? AND state = 'open'`,
					)
					.run(this.now(), old.question_id);
		});
	}

	private ownPending(from: string | null, id: string): MessageRow {
		const row = this.db
			.prepare(`SELECT * FROM message WHERE id = ?`)
			.get(id) as MessageRow | undefined;
		if (!row) throw new ShipmatesError(`no message ${id}`, 'not-found');
		if (row.from_session !== from)
			throw new ShipmatesError(`message ${id} is not yours`, 'not-yours');
		if (row.state !== 'pending')
			throw new ShipmatesError(
				`message ${id} is already ${row.state}`,
				row.state,
			);
		if (this.isClaimed(row))
			throw new ShipmatesError(
				`message ${id} is being delivered right now`,
				'delivering',
			);
		return row;
	}

	/**
	 * Claimed by a live process whose lease has not expired, THIS process
	 * included: a message this process is already delivering must not be handed
	 * out again (measured: re-claiming returned in-flight messages twice).
	 */
	private isClaimed(m: MessageRow): boolean {
		if (m.claim_pid === null || m.claim_until === null) return false;
		if (m.claim_until < this.now()) return false;
		const me = this.probe.self();
		return this.probe.isAlive({
			pid: m.claim_pid,
			startTime: m.claim_start,
			bootId: me.bootId,
			host: me.host,
		});
	}

	private pendingRows(sessionFile: string): MessageRow[] {
		return this.db
			.prepare(
				`SELECT * FROM message WHERE state = 'pending' AND (
				   (to_kind = 'session' AND to_target = ?) OR
				   (to_kind = 'role' AND to_target IN (SELECT role FROM role WHERE session_file = ?)))
				 ORDER BY created_at, rowid`,
			)
			.all(sessionFile, sessionFile) as MessageRow[];
	}

	// --------------------------------------------------------------- questions

	question(id: string): Question | null {
		const row = this.db
			.prepare(`SELECT * FROM question WHERE id = ?`)
			.get(id) as QuestionRow | undefined;
		return row ? toQuestion(row) : null;
	}

	/** Open questions addressed to this session, directly or through a role it holds. */
	openQuestionsTo(sessionFile: string): Question[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM question WHERE state = 'open' AND (
				   (to_kind = 'session' AND to_target = ?) OR
				   (to_kind = 'role' AND to_target IN (SELECT role FROM role WHERE session_file = ?)))
				 ORDER BY created_at`,
			)
			.all(sessionFile, sessionFile) as QuestionRow[];
		return rows.map(toQuestion);
	}

	/**
	 * Answer a question: the only way to close one (D12). The answer is sent back
	 * to the asker as a message. Only the session it was asked of answers it
	 * (for a role, its current holder); `from: null` is a human at the CLI.
	 */
	answer(input: {
		from: string | null;
		questionId: string;
		text: string;
		origin?: Origin;
		relay?: Relay | null;
	}): Message {
		const q = this.question(input.questionId);
		if (!q)
			throw new ShipmatesError(`no question ${input.questionId}`, 'not-found');
		if (q.state !== 'open')
			throw new ShipmatesError(
				`question ${q.id} is already ${q.state}`,
				q.state,
			);
		if (input.from !== null) {
			const addressee =
				q.to.kind === 'session' ? q.to.target : this.roleHolder(q.to.target);
			if (addressee !== input.from)
				throw new ShipmatesError(
					`question ${q.id} was not asked of ${input.from}`,
					'not-asked',
				);
		}
		const origin = input.origin ?? (input.from ? 'agent' : 'human');
		if (origin === 'human-relayed' && !input.relay)
			throw new ShipmatesError(
				'a human-relayed answer must carry the relay',
				'no-relay',
			);
		const id = this.tx(() => {
			const t = this.now();
			this.db
				.prepare(
					`UPDATE question SET state = 'answered', answer = ?, answer_origin = ?, answer_relay = ?, answered_by = ?, finished_at = ? WHERE id = ?`,
				)
				.run(
					input.text,
					origin,
					input.relay ? JSON.stringify(input.relay) : null,
					input.from ?? 'human',
					t,
					q.id,
				);
			return this.insertMessage({
				from: input.from,
				fromLabel: this.labelOf(input.from),
				to: q.asker
					? {kind: 'session', target: q.asker}
					: {kind: 'role', target: q.askerLabel},
				kind: 'answer',
				text: input.text,
				origin,
				relay: input.relay ?? null,
				questionId: q.id,
			});
		});
		return this.message(id)!;
	}

	/**
	 * What `session_wait` returns on (D12), or null to keep waiting: the answer;
	 * the target settling (idle or waiting for the human) after the wait began
	 * without answering; a new question addressed to the waiter (two sessions
	 * waiting on each other would otherwise deadlock until the timeout); or the
	 * question being withdrawn.
	 */
	waitStatus(input: {
		waiter: string;
		questionId: string;
		since: number;
	}): WaitStatus | null {
		const q = this.question(input.questionId);
		if (!q)
			throw new ShipmatesError(`no question ${input.questionId}`, 'not-found');
		if (q.state === 'answered') return {status: 'answered', question: q};
		if (q.state === 'withdrawn') return {status: 'withdrawn', question: q};
		const asked = this.openQuestionsTo(input.waiter).filter(
			(x) => x.createdAt >= input.since,
		);
		if (asked.length) return {status: 'asked', question: q, questions: asked};
		const session =
			q.to.kind === 'session' ? q.to.target : this.roleHolder(q.to.target);
		const target = session ? this.presence(session) : null;
		if (
			target?.live &&
			target.state !== 'running' &&
			target.state !== 'waiting-for-session' &&
			(target.settledAt ?? 0) > input.since
		)
			return {status: 'settled', question: q, target};
		return null;
	}

	// -------------------------------------------------------------- the human

	/** Raise an attention item: a question for the human, in the one inbox (D13). */
	humanAsk(input: {
		from: string;
		question: string;
		options?: string[];
		blocking?: boolean;
		onBehalfOf?: string[];
	}): AttentionItem {
		const onBehalfOf = input.onBehalfOf ?? [];
		for (const qid of onBehalfOf)
			if (!this.question(qid))
				throw new ShipmatesError(
					`onBehalfOf names no question: ${qid}`,
					'not-found',
				);
		const id = newId('h');
		this.tx(() => {
			this.db
				.prepare(
					`INSERT INTO item(id, session_file, question, options, blocking, on_behalf_of, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					id,
					input.from,
					input.question,
					input.options?.length ? JSON.stringify(input.options) : null,
					input.blocking ? 1 : 0,
					onBehalfOf.length ? JSON.stringify(onBehalfOf) : null,
					this.now(),
				);
		});
		return this.item(id)!;
	}

	item(id: string): AttentionItem | null {
		const row = this.db.prepare(`SELECT * FROM item WHERE id = ?`).get(id) as
			ItemRow | undefined;
		return row ? toItem(row) : null;
	}

	/** Open items, oldest first; blocking ones first of all. */
	inbox(): AttentionItem[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM item WHERE state = 'open' ORDER BY blocking DESC, created_at`,
			)
			.all() as ItemRow[];
		return rows.map(toItem);
	}

	/**
	 * The human answered an item. Callers must only call this for a real human act
	 * (a slash command, the CLI at a terminal, a host's authenticated UI, a human
	 * turn in the asking session): ADR 0003.
	 *
	 * The answer goes to the asking session as a message of origin `human`, unless
	 * `deliver` is false: the human said it in that session's own turn, so their
	 * words are already in its transcript and a second copy would repeat them (D39).
	 */
	answerItem(
		itemId: string,
		text: string,
		opts: {channel: string; deliver?: true},
	): Message;
	answerItem(
		itemId: string,
		text: string,
		opts: {channel: string; deliver: boolean},
	): Message | null;
	answerItem(
		itemId: string,
		text: string,
		opts: {channel: string; deliver?: boolean},
	): Message | null {
		// Checked inside the write: the session's input handler and another
		// channel (the CLI, a host) may answer the same item at the same moment,
		// and only one of them may win (D39).
		const id = this.tx(() => {
			const item = this.item(itemId);
			if (!item) throw new ShipmatesError(`no item ${itemId}`, 'not-found');
			if (item.state !== 'open')
				throw new ShipmatesError(
					`item ${itemId} is already ${item.state}`,
					item.state,
				);
			return this.closeItem(item, text, opts);
		});
		return id ? this.message(id)! : null;
	}

	/**
	 * The human replied in the session that raised these items (D39): every item
	 * of `sessionFile` still open, except `except`, is answered with their words
	 * on `opts.channel` (by convention `session`). Returns the items it closed.
	 *
	 * With `notice`, the session also gets one `notice` message (origin agent,
	 * from shipmates) naming the items the reply closed: the human's words are in
	 * its turn, but nothing else would tell the agent which questions they
	 * closed, and it may still be waiting on one of them.
	 */
	answerOpenItemsOf(
		sessionFile: string,
		text: string,
		opts: {
			channel: string;
			deliver?: boolean;
			except?: string[];
			notice?: boolean;
		},
	): AttentionItem[] {
		const skip = new Set(opts.except ?? []);
		const open = () =>
			(
				this.db
					.prepare(
						`SELECT * FROM item WHERE session_file = ? AND state = 'open' ORDER BY created_at`,
					)
					.all(sessionFile) as ItemRow[]
			).filter((r) => !skip.has(r.id));
		// Read first: the write lock only when there is something to close
		// (every human input calls this; most sessions have no open item).
		if (!open().length) return [];
		return this.tx(() => {
			const rows = open();
			for (const r of rows) this.closeItem(toItem(r), text, opts);
			if (opts.notice && rows.length)
				this.insertMessage({
					from: null,
					fromLabel: 'shipmates',
					to: {kind: 'session', target: sessionFile},
					kind: 'notice',
					text: `The human's reply in this session closed ${rows.length === 1 ? 'your inbox item' : `${rows.length} of your inbox items`} (answered with their words, channel ${opts.channel}): ${rows.map((r) => `${r.id} "${r.question.slice(0, 120)}"`).join('; ')}. If it did not answer one of them, ask again.`,
					origin: 'agent',
				});
			return rows.map((r) => r.id);
		}).map((id) => this.item(id)!);
	}

	/** Inside a write: mark an open item answered, and send the answer unless told not to. */
	private closeItem(
		item: AttentionItem,
		text: string,
		opts: {channel: string; deliver?: boolean},
	): string | null {
		const t = this.now();
		const r = this.db
			.prepare(
				`UPDATE item SET state = 'answered', answer = ?, answer_channel = ?, finished_at = ? WHERE id = ? AND state = 'open'`,
			)
			.run(text, opts.channel, t, item.id);
		if (Number(r.changes) !== 1)
			throw new ShipmatesError(`item ${item.id} is no longer open`, 'answered');
		if (opts.deliver === false) return null;
		const relay: Relay = {
			text,
			channel: opts.channel,
			session: null,
			itemId: item.id,
			at: t,
		};
		return this.insertMessage({
			from: null,
			fromLabel: 'human',
			to: {kind: 'session', target: item.session},
			kind: 'answer',
			text,
			origin: 'human',
			relay,
			itemId: item.id,
		});
	}

	/**
	 * Withdraw an item this session raised and that is still open. Refused for
	 * another session's item: only the asker knows the question no longer stands.
	 * Returns the item as it now is (unchanged when it was already answered).
	 */
	withdrawItem(from: string, itemId: string): AttentionItem {
		const item = this.item(itemId);
		if (!item) throw new ShipmatesError(`no item ${itemId}`, 'not-found');
		if (item.session !== from)
			throw new ShipmatesError(
				`item ${itemId} was raised by ${this.labelOf(item.session)}, not by you`,
				'not-yours',
			);
		this.tx(() => {
			this.db
				.prepare(
					`UPDATE item SET state = 'withdrawn', finished_at = ? WHERE id = ? AND session_file = ? AND state = 'open'`,
				)
				.run(this.now(), itemId, from);
		});
		return this.item(itemId)!;
	}

	/**
	 * Items that closed (answered or withdrawn) at or after `since`, oldest
	 * first: what a host reads to update its own copy of an item it pushed to
	 * the human (a Telegram message that must stop looking open, D39).
	 */
	itemsFinishedSince(since: number): AttentionItem[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM item WHERE state != 'open' AND finished_at >= ? ORDER BY finished_at, rowid`,
			)
			.all(since) as ItemRow[];
		return rows.map(toItem);
	}

	/** The human's answers to this session's items, newest first. */
	humanAnswers(sessionFile: string): AttentionItem[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM item WHERE session_file = ? AND state = 'answered' ORDER BY finished_at DESC`,
			)
			.all(sessionFile) as ItemRow[];
		return rows.map(toItem);
	}

	/**
	 * Record a turn a human really typed into this session (ADR 0003): TUI input,
	 * or a host's `shipmates:human-input` mark. Never call this for agent text.
	 */
	recordHumanTurn(
		sessionFile: string,
		input: {text: string; channel: string},
	): string {
		const id = newId('t');
		this.tx(() => {
			this.db
				.prepare(
					`INSERT INTO human_turn(id, session_file, text, channel, at) VALUES(?, ?, ?, ?, ?)`,
				)
				.run(id, sessionFile, input.text, input.channel, this.now());
		});
		return id;
	}

	/**
	 * Build the relay for a human-relayed message: the human's own words, found
	 * among this session's recent human turns (by a quote the agent gives, or the
	 * latest turn), or an answered inbox item of this session. An agent can carry
	 * a human's words; it cannot make them up.
	 */
	relayFromHuman(
		sessionFile: string,
		ref: {quote?: string; itemId?: string},
	): Relay {
		if (ref.itemId) {
			const item = this.item(ref.itemId);
			if (
				!item ||
				item.session !== sessionFile ||
				item.state !== 'answered' ||
				item.answer === null
			)
				throw new ShipmatesError(
					`no answered inbox item ${ref.itemId} for this session`,
					'no-human-turn',
				);
			return {
				text: item.answer,
				channel: item.answerChannel ?? 'unknown',
				session: null,
				itemId: item.id,
				at: this.now(),
			};
		}
		const turns = this.db
			.prepare(
				`SELECT * FROM human_turn WHERE session_file = ? ORDER BY at DESC, rowid DESC LIMIT 20`,
			)
			.all(sessionFile) as {
			id: string;
			text: string;
			channel: string;
			at: number;
		}[];
		const norm = (x: string) => x.replace(/\s+/g, ' ').trim().toLowerCase();
		const turn = ref.quote
			? turns.find((t) => norm(t.text).includes(norm(ref.quote!)))
			: turns[0];
		if (!turn)
			throw new ShipmatesError(
				ref.quote
					? `no human turn in this session contains ${JSON.stringify(ref.quote)}: only words the human typed can be relayed`
					: 'no human turn in this session to relay',
				'no-human-turn',
			);
		return {
			text: turn.text,
			channel: turn.channel,
			session: sessionFile,
			turnId: turn.id,
			at: turn.at,
		};
	}

	/** Open questions this session asked. */
	openQuestionsFrom(sessionFile: string): Question[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM question WHERE state = 'open' AND asker_session = ? ORDER BY created_at`,
			)
			.all(sessionFile) as QuestionRow[];
		return rows.map(toQuestion);
	}

	/** Messages this session may receive now: to it, or to a role it holds. */
	pendingFor(sessionFile: string): Message[] {
		return this.pendingRows(sessionFile).map((r) => this.toMessage(r));
	}

	message(id: string): Message | null {
		const row = this.db
			.prepare(`SELECT * FROM message WHERE id = ?`)
			.get(id) as MessageRow | undefined;
		return row ? this.toMessage(row) : null;
	}

	protected insertMessage(m: {
		from: string | null;
		fromLabel: string;
		to: {kind: 'session' | 'role'; target: string};
		kind: Message['kind'];
		text: string;
		origin: Origin;
		relay?: Relay | null;
		questionId?: string | null;
		itemId?: string | null;
		requestId?: string | null;
		urgent?: boolean;
	}): string {
		const id = newId('m');
		this.db
			.prepare(
				`INSERT INTO message(id, from_session, from_label, to_kind, to_target, kind, question_id, item_id, text, origin, relay, request_id, urgent, created_at)
				 VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				m.from,
				m.fromLabel,
				m.to.kind,
				m.to.target,
				m.kind,
				m.questionId ?? null,
				m.itemId ?? null,
				m.text,
				m.origin,
				m.relay ? JSON.stringify(m.relay) : null,
				m.requestId ?? null,
				m.urgent ? 1 : 0,
				this.now(),
			);
		return id;
	}

	/** How a sender is named to receivers: its roles if it has any, else its file. */
	labelOf(sessionFile: string | null): string {
		if (!sessionFile) return 'human';
		const roles = this.rolesOf(sessionFile);
		return roles.length ? roles.join(',') : sessionFile;
	}

	protected toMessage(r: MessageRow): Message {
		return {
			id: r.id,
			from: r.from_session,
			fromLabel: r.from_label,
			to: {kind: r.to_kind, target: r.to_target},
			kind: r.kind,
			questionId: r.question_id,
			itemId: r.item_id,
			text: r.text,
			origin: r.origin,
			relay: r.relay ? (JSON.parse(r.relay) as Relay) : null,
			urgent: r.urgent === 1,
			state: r.state,
			supersededBy: r.superseded_by,
			deliveredTo: r.delivered_to,
			createdAt: r.created_at,
		};
	}

	// --------------------------------------------------------------- ownership

	/**
	 * Start a spawn: the ownership record exists before the new session does, so
	 * a terminal child can bind itself at its own `session_start` (D28). The owner
	 * is fixed here and never changes.
	 */
	beginSpawn(input: SpawnInput): Ownership {
		if (input.prompt && Buffer.byteLength(input.prompt) > MAX_TEXT_BYTES)
			throw new ShipmatesError(
				`the first prompt is over 8 KB (${Buffer.byteLength(input.prompt)} bytes): put the plan in git and point at it`,
				'too-large',
			);
		if (input.role && !ROLE_RE.test(input.role))
			throw new ShipmatesError(
				`invalid role ${JSON.stringify(input.role)}`,
				'bad-role',
			);
		const id = newId('sp');
		this.tx(() => {
			this.db
				.prepare(
					`INSERT INTO ownership(id, owner, folder, role, via, detail, prompt, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					id,
					input.owner,
					input.folder,
					input.role ?? null,
					input.via,
					input.detail ? JSON.stringify(input.detail) : null,
					input.prompt ?? null,
					this.now(),
				);
		});
		return this.spawnRecord(id)!;
	}

	/**
	 * The spawned session exists: bind it to its spawn, once, and queue its first
	 * prompt as a `spawn` message from the owner, origin agent (never a human
	 * turn, D28). Binding the same session again is a no-op; a session that is
	 * already owned, or a spawn bound to another session, is refused: ownership
	 * never changes.
	 */
	bindSpawn(spawnId: string, sessionFile: string): Ownership {
		this.tx(() => {
			const row = this.db
				.prepare(`SELECT * FROM ownership WHERE id = ?`)
				.get(spawnId) as OwnershipRow | undefined;
			if (!row) throw new ShipmatesError(`no spawn ${spawnId}`, 'not-found');
			if (row.session_file === sessionFile) return;
			if (row.session_file)
				throw new ShipmatesError(
					`spawn ${spawnId} is already ${row.session_file}`,
					'owned',
				);
			const other = this.db
				.prepare(`SELECT owner FROM ownership WHERE session_file = ?`)
				.get(sessionFile) as {owner: string} | undefined;
			if (other)
				throw new ShipmatesError(
					`${sessionFile} is already owned by ${other.owner}; ownership never changes`,
					'owned',
				);
			if (
				sessionFile === row.owner ||
				this.ancestors(row.owner).includes(sessionFile)
			)
				throw new ShipmatesError(
					`${sessionFile} cannot be owned by ${row.owner}: that would be a cycle`,
					'cycle',
				);
			this.db
				.prepare(
					`UPDATE ownership SET session_file = ?, bound_at = ? WHERE id = ?`,
				)
				.run(sessionFile, this.now(), spawnId);
			if (row.prompt)
				this.insertMessage({
					from: row.owner,
					fromLabel: this.labelOf(row.owner),
					to: {kind: 'session', target: sessionFile},
					kind: 'spawn',
					text: row.prompt,
					origin: 'agent',
					requestId: `spawn:${spawnId}`,
				});
		});
		return this.spawnRecord(spawnId)!;
	}

	/** Record that `owner` owns an existing session (a host that spawned it by its own means). */
	recordOwnership(input: SpawnInput & {session: string}): Ownership {
		const sp = this.beginSpawn(input);
		try {
			return this.bindSpawn(sp.id, input.session);
		} catch (e) {
			this.tx(() => {
				this.db.prepare(`DELETE FROM ownership WHERE id = ?`).run(sp.id);
			});
			throw e;
		}
	}

	spawnRecord(spawnId: string): Ownership | null {
		const row = this.db
			.prepare(`SELECT * FROM ownership WHERE id = ?`)
			.get(spawnId) as OwnershipRow | undefined;
		return row ? this.toOwnership(row) : null;
	}

	/** The ownership record of a session, or null when nobody spawned it. */
	ownership(sessionFile: string): Ownership | null {
		const row = this.db
			.prepare(`SELECT * FROM ownership WHERE session_file = ?`)
			.get(sessionFile) as OwnershipRow | undefined;
		return row ? this.toOwnership(row) : null;
	}

	ownerOf(sessionFile: string): string | null {
		return this.ownership(sessionFile)?.owner ?? null;
	}

	/**
	 * The sessions `owner` spawned, live or not, oldest first; with `transitive`,
	 * their own children too (depth first). Spawns that never came up are left out.
	 */
	ownedBy(owner: string, opts: {transitive?: boolean} = {}): Ownership[] {
		const out: Ownership[] = [];
		const seen = new Set([owner]);
		const walk = (o: string) => {
			const rows = this.db
				.prepare(
					`SELECT * FROM ownership WHERE owner = ? AND session_file IS NOT NULL ORDER BY created_at, rowid`,
				)
				.all(o) as OwnershipRow[];
			for (const r of rows) {
				if (seen.has(r.session_file!)) continue;
				seen.add(r.session_file!);
				out.push(this.toOwnership(r));
				if (opts.transitive) walk(r.session_file!);
			}
		};
		walk(owner);
		return out;
	}

	/**
	 * Whether `caller` owns `target`, directly or through the sessions it owns
	 * (D23): an orchestrator answers for its children's children too.
	 */
	owns(caller: string, target: string): boolean {
		return this.ancestors(target).includes(caller);
	}

	/** The owner, the owner's owner, and so on up. */
	private ancestors(sessionFile: string): string[] {
		const out: string[] = [];
		for (let s = this.ownerOf(sessionFile); s && out.length < 64;) {
			if (out.includes(s)) break;
			out.push(s);
			s = this.ownerOf(s);
		}
		return out;
	}

	/**
	 * A host archives or deletes a session: mark it and every session it owns,
	 * transitively, as one batch (D24). shipmates cannot touch transcripts; the host
	 * hides or deletes them, and must keep a deleted one until `undoUntil`.
	 * Sessions already archived keep their own batch.
	 */
	archive(
		sessionFile: string,
		opts: {kind: ArchiveMark['kind']; by: string},
	): {batch: string; at: number; undoUntil: number; sessions: string[]} {
		const batch = newId('ar');
		const at = this.now();
		const sessions = this.tx(() => {
			// Inside the transaction, so a child bound meanwhile is not missed.
			const all = [
				sessionFile,
				...this.ownedBy(sessionFile, {transitive: true}).map((o) => o.session!),
			];
			const marked: string[] = [];
			for (const s of all) {
				const r = this.db
					.prepare(
						`INSERT INTO archive(session_file, kind, batch, by_label, at) VALUES(?, ?, ?, ?, ?) ON CONFLICT(session_file) DO NOTHING`,
					)
					.run(s, opts.kind, batch, opts.by, at);
				if (r.changes) marked.push(s);
			}
			return marked;
		});
		return {batch, at, undoUntil: at + ARCHIVE_UNDO_MS, sessions};
	}

	/** Undo a whole archive batch within its window; returns the sessions restored. */
	undoArchive(batch: string): string[] {
		return this.tx(() => {
			const rows = this.db
				.prepare(`SELECT * FROM archive WHERE batch = ?`)
				.all(batch) as ArchiveRow[];
			if (!rows.length)
				throw new ShipmatesError(`no archive batch ${batch}`, 'not-found');
			if (rows[0].at + ARCHIVE_UNDO_MS < this.now())
				throw new ShipmatesError(
					`archive ${batch} is past its undo window (7 days)`,
					'expired',
				);
			this.db.prepare(`DELETE FROM archive WHERE batch = ?`).run(batch);
			return rows.map((r) => r.session_file);
		});
	}

	archiveMark(sessionFile: string): ArchiveMark | null {
		const row = this.db
			.prepare(`SELECT * FROM archive WHERE session_file = ?`)
			.get(sessionFile) as ArchiveRow | undefined;
		return row ? toArchive(row) : null;
	}

	/** Marks whose undo window has passed: a host may now make them permanent. */
	expiredArchives(): ArchiveMark[] {
		return (
			this.db
				.prepare(`SELECT * FROM archive WHERE at < ? ORDER BY at`)
				.all(this.now() - ARCHIVE_UNDO_MS) as ArchiveRow[]
		).map(toArchive);
	}

	/**
	 * D29: the headless children of `owner` that have messages to read which
	 * arrived after their last stop, and are not archived. One cached query,
	 * since every session's poller asks on every change. Measured: 3 µs for a
	 * session that owns nothing, 42 µs with 5 children and one to wake, against
	 * about 500 µs as separate reads per child; with the settings join (D40),
	 * 1.2 µs and 17 µs on a later run of the same case. Liveness is left to the caller:
	 * it is a process probe, not SQL.
	 *
	 * The child's own settings apply, as `planDelivery` would apply them were it
	 * up (D40): never with wake off, and while it declared waiting-for-human only
	 * for a message of origin `human` (D37). Without that, a child whose
	 * human_ask timed out was restarted by its owner's next message, which that
	 * run then delivered before the human answered.
	 */
	wakeCandidates(owner: string): Ownership[] {
		const rows = this.cached(
			`SELECT o.* FROM ownership o
			 LEFT JOIN (SELECT session_file, max(at) AS at FROM stop_request GROUP BY session_file) s
			   ON s.session_file = o.session_file
			 LEFT JOIN session_setting st ON st.session_file = o.session_file
			 WHERE o.owner = ? AND o.via = 'headless' AND o.session_file IS NOT NULL
			   AND COALESCE(st.wake, 1) = 1
			   AND NOT EXISTS (SELECT 1 FROM archive a WHERE a.session_file = o.session_file)
			   AND (EXISTS (SELECT 1 FROM message m WHERE m.state = 'pending' AND m.to_kind = 'session'
			                  AND m.to_target = o.session_file AND m.created_at > COALESCE(s.at, -1)
			                  AND (COALESCE(st.declared_waiting, 0) = 0 OR m.origin = 'human'))
			     OR EXISTS (SELECT 1 FROM role r JOIN message m ON m.state = 'pending' AND m.to_kind = 'role'
			                  AND m.to_target = r.role
			                WHERE r.session_file = o.session_file AND m.created_at > COALESCE(s.at, -1)
			                  AND (COALESCE(st.declared_waiting, 0) = 0 OR m.origin = 'human')))
			 ORDER BY o.created_at`,
		).all(owner) as OwnershipRow[];
		return rows.map((r) => this.toOwnership(r));
	}

	/**
	 * Prepared once per connection, for the queries the poller runs on every
	 * change: compiling a statement is most of the cost of a small query.
	 */
	private statements = new Map<string, ReturnType<DB['prepare']>>();
	private cached(sql: string): ReturnType<DB['prepare']> {
		let st = this.statements.get(sql);
		if (!st) this.statements.set(sql, (st = this.db.prepare(sql)));
		return st;
	}

	/**
	 * A headless child is being woken (D29): granted to exactly one caller until
	 * the lease lapses, so two polls or two processes never start it twice. A
	 * refusal says when the current lease ends, so the caller can look again then.
	 */
	leaseWake(
		sessionFile: string,
		ms: number,
	): {ok: true} | {ok: false; until: number | null} {
		// Read first: a refused lease must not write. A write bumps changeToken(),
		// which wakes every poller, which asks again: a write-lock loop every
		// poll while the lease is held (invariant 4's reason; found in review).
		const held = this.db
			.prepare(`SELECT wake_until FROM ownership WHERE session_file = ?`)
			.get(sessionFile) as {wake_until: number | null} | undefined;
		if (!held) return {ok: false, until: null};
		if (held.wake_until != null && held.wake_until >= this.now())
			return {ok: false, until: held.wake_until};
		return this.tx(() => {
			const t = this.now();
			const r = this.db
				.prepare(
					`UPDATE ownership SET wake_until = ? WHERE session_file = ? AND (wake_until IS NULL OR wake_until < ?)`,
				)
				.run(t + ms, sessionFile, t);
			if (r.changes === 1) return {ok: true as const};
			const row = this.db
				.prepare(`SELECT wake_until FROM ownership WHERE session_file = ?`)
				.get(sessionFile) as {wake_until: number | null} | undefined;
			return {ok: false as const, until: row?.wake_until ?? null};
		});
	}

	/**
	 * The woken child is up: shorten its lease to `gapMs` from now. Once it has
	 * exited, the next wake may come after that gap, not before: a child that
	 * dies before reading its messages is retried at that pace, never in a loop.
	 */
	wakeDone(sessionFile: string, gapMs: number): void {
		const until = this.now() + gapMs;
		const row = this.db
			.prepare(`SELECT wake_until FROM ownership WHERE session_file = ?`)
			.get(sessionFile) as {wake_until: number | null} | undefined;
		// No write lock for nothing (the reason behind invariant 4).
		if (row?.wake_until == null || row.wake_until <= until) return;
		this.tx(() => {
			this.db
				.prepare(
					`UPDATE ownership SET wake_until = ? WHERE session_file = ? AND wake_until > ?`,
				)
				.run(until, sessionFile, until);
		});
	}

	protected toOwnership(r: OwnershipRow): Ownership {
		return {
			id: r.id,
			session: r.session_file,
			owner: r.owner,
			folder: r.folder,
			role: r.role,
			via: r.via,
			detail: r.detail ? (JSON.parse(r.detail) as Record<string, unknown>) : {},
			createdAt: r.created_at,
			boundAt: r.bound_at,
			archived: r.session_file ? this.archiveMark(r.session_file) : null,
		};
	}

	// -------------------------------------------------------------------- stop

	/**
	 * Ask a session to stop its current turn (D30). Its own extension acts on it
	 * at the next poll and records the outcome; it never cascades. Authorisation
	 * is the caller's job: the tool checks `owns`, the CLI that a human runs it.
	 */
	requestStop(sessionFile: string, opts: {by: string | null}): StopRequest {
		const id = newId('s');
		this.tx(() => {
			this.db
				.prepare(
					`INSERT INTO stop_request(id, session_file, by_session, by_label, at) VALUES(?, ?, ?, ?, ?)`,
				)
				.run(id, sessionFile, opts.by, this.labelOf(opts.by), this.now());
		});
		return this.stopRequest(id)!;
	}

	stopRequest(id: string): StopRequest | null {
		const row = this.db
			.prepare(`SELECT * FROM stop_request WHERE id = ?`)
			.get(id) as StopRow | undefined;
		return row ? toStop(row) : null;
	}

	/** Stop requests this session has not acted on yet, oldest first. A read: no lock. */
	openStops(sessionFile: string): StopRequest[] {
		return (
			this.cached(
				`SELECT * FROM stop_request WHERE session_file = ? AND handled_at IS NULL ORDER BY at, rowid`,
			).all(sessionFile) as StopRow[]
		).map(toStop);
	}

	settleStop(id: string, outcome: 'stopped' | 'not-running'): void {
		this.tx(() => {
			this.db
				.prepare(
					`UPDATE stop_request SET handled_at = ?, outcome = ? WHERE id = ? AND handled_at IS NULL`,
				)
				.run(this.now(), outcome, id);
		});
	}

	/** When this session was last asked to stop, or null. */
	lastStopAt(sessionFile: string): number | null {
		const row = this.db
			.prepare(`SELECT max(at) AS at FROM stop_request WHERE session_file = ?`)
			.get(sessionFile) as {at: number | null};
		return row.at;
	}

	// --------------------------------------------------------------- retention

	/**
	 * D11: finished messages, questions and items go after 30 days (the receiver's
	 * transcript keeps every delivered message for good); presence of a dead process
	 * after a day. Pending messages and open questions are never pruned by age.
	 */
	prune(): void {
		const t = this.now();
		const finished = t - 30 * DAY;
		const dead = this.db
			.prepare(`SELECT * FROM presence WHERE updated_at < ?`)
			.all(t - DAY) as PresenceRow[];
		this.tx(() => {
			this.db
				.prepare(
					`DELETE FROM message WHERE state != 'pending' AND finished_at < ?`,
				)
				.run(finished);
			this.db
				.prepare(
					`DELETE FROM question WHERE state != 'open' AND finished_at < ?`,
				)
				.run(finished);
			this.db
				.prepare(`DELETE FROM item WHERE state != 'open' AND finished_at < ?`)
				.run(finished);
			this.db.prepare(`DELETE FROM human_turn WHERE at < ?`).run(finished);
			this.db
				.prepare(
					`DELETE FROM stop_request WHERE handled_at IS NOT NULL AND handled_at < ?`,
				)
				.run(finished);
			this.pruneOwnership(t);
			this.pruneSettings(t);
			for (const row of dead)
				if (!this.probe.isAlive(this.identityOf(row)))
					this.db
						.prepare(`DELETE FROM presence WHERE session_file = ? AND pid = ?`)
						.run(row.session_file, row.pid);
			this.db
				.prepare(
					`INSERT OR REPLACE INTO meta(key, value) VALUES('last_prune', ?)`,
				)
				.run(String(t));
		});
	}

	/**
	 * D25: ownership is never pruned while its session exists. A spawn that never
	 * came up goes after a day. A bound record goes only when its transcript file
	 * is gone, nobody runs it, and it is over 30 days old (pi writes a transcript
	 * only after the first assistant message, so a missing file alone proves
	 * nothing about a fresh session). An archive mark goes with its transcript,
	 * once the undo window has passed. Called inside prune's transaction.
	 */
	private pruneOwnership(t: number): void {
		this.db
			.prepare(
				`DELETE FROM ownership WHERE session_file IS NULL AND created_at < ?`,
			)
			.run(t - DAY);
		const old = this.db
			.prepare(
				`SELECT session_file FROM ownership WHERE session_file IS NOT NULL AND bound_at < ?`,
			)
			.all(t - 30 * DAY) as {session_file: string}[];
		for (const {session_file} of old)
			if (!fs.existsSync(session_file) && !this.isLive(session_file))
				this.db
					.prepare(`DELETE FROM ownership WHERE session_file = ?`)
					.run(session_file);
		const marks = this.db
			.prepare(`SELECT session_file FROM archive WHERE at < ?`)
			.all(t - Math.max(ARCHIVE_UNDO_MS, 30 * DAY)) as {session_file: string}[];
		for (const {session_file} of marks)
			if (!fs.existsSync(session_file))
				this.db
					.prepare(`DELETE FROM archive WHERE session_file = ?`)
					.run(session_file);
	}

	/**
	 * D40: a session's settings are kept while its transcript exists, as D25 keeps
	 * ownership: they go when the file is gone, nobody runs it, and they were last
	 * changed over 30 days ago. Called inside prune's transaction.
	 */
	private pruneSettings(t: number): void {
		const old = this.db
			.prepare(`SELECT session_file FROM session_setting WHERE updated_at < ?`)
			.all(t - 30 * DAY) as {session_file: string}[];
		for (const {session_file} of old)
			if (!fs.existsSync(session_file) && !this.isLive(session_file))
				this.db
					.prepare(`DELETE FROM session_setting WHERE session_file = ?`)
					.run(session_file);
	}

	/** Prune when the last prune is a day old. Cheap enough to call on every open. */
	pruneIfDue(): boolean {
		const row = this.db
			.prepare(`SELECT value FROM meta WHERE key = 'last_prune'`)
			.get() as {value: string} | undefined;
		if (row && Number(row.value) > this.now() - DAY) return false;
		this.prune();
		return true;
	}

	protected identityOf(row: {
		pid: number;
		start_time: string | null;
		boot_id: string | null;
		host: string | null;
	}): ProcessIdentity {
		return {
			pid: row.pid,
			startTime: row.start_time,
			bootId: row.boot_id,
			host: row.host ?? '',
		};
	}

	protected rolesOf(sessionFile: string): string[] {
		return (
			this.db
				.prepare(`SELECT role FROM role WHERE session_file = ? ORDER BY role`)
				.all(sessionFile) as {role: string}[]
		).map((r) => r.role);
	}

	private toPresence(r: PresenceRow): Presence {
		return {
			sessionFile: r.session_file,
			sessionId: r.session_id,
			cwd: r.cwd,
			branch: r.branch,
			roles: this.rolesOf(r.session_file),
			state: r.state,
			status: r.status,
			refs: r.refs ? (JSON.parse(r.refs) as string[]) : [],
			waitingOn: r.waiting_on,
			wake: r.s_wake === 1,
			declaredWaiting: r.s_declared_waiting === 1,
			live: this.probe.isAlive(this.identityOf(r)),
			pid: r.pid,
			updatedAt: r.updated_at,
			settledAt: r.settled_at,
		};
	}
}

export function openShipmates(opts: ShipmatesOptions = {}): Shipmates {
	return new Shipmates(opts);
}
