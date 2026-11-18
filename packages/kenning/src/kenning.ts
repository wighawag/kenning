import {defaultStateDir, openDb, write, type DB} from './store.js';
import {OsProbe, type ProcessIdentity, type ProcessProbe} from './liveness.js';
import {
	KenningError,
	type AttentionItem,
	type Message,
	type Origin,
	type Presence,
	type Question,
	type Relay,
	type SessionState,
} from './types.js';
import {newId} from './ids.js';

export interface KenningOptions {
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
	wake?: boolean;
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
	wake: number;
	pid: number;
	start_time: string | null;
	boot_id: string | null;
	host: string | null;
	updated_at: number;
	settled_at: number | null;
};

/** D14: message text is short; content stays in git and messages point at it. */
const DAY = 86_400_000;

export const MAX_TEXT_BYTES = 8 * 1024;

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

export class Kenning {
	readonly db: DB;
	readonly probe: ProcessProbe;
	readonly now: () => number;
	private localWrites = 0;

	constructor(opts: KenningOptions = {}) {
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
			this.db
				.prepare(
					`INSERT INTO presence(session_file, session_id, cwd, branch, state, pid, start_time, boot_id, host, registered_at, updated_at)
					 VALUES(?, ?, ?, ?, 'idle', ?, ?, ?, ?, ?, ?)
					 ON CONFLICT(session_file) DO UPDATE SET
					   session_id = excluded.session_id, cwd = excluded.cwd,
					   branch = COALESCE(excluded.branch, presence.branch),
					   pid = excluded.pid, start_time = excluded.start_time, boot_id = excluded.boot_id,
					   host = excluded.host, updated_at = excluded.updated_at,
					   state = CASE WHEN presence.pid = excluded.pid THEN presence.state ELSE 'idle' END`,
				)
				.run(
					input.sessionFile,
					input.sessionId ?? null,
					input.cwd ?? null,
					input.branch ?? null,
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
		if (patch.wake !== undefined) put('wake', patch.wake ? 1 : 0);
		put('updated_at', this.now());
		this.tx(() => {
			this.db
				.prepare(
					`UPDATE presence SET ${sets.join(', ')} WHERE session_file = ?`,
				)
				.run(...vals, sessionFile);
		});
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

	presence(sessionFile: string): Presence | null {
		const row = this.db
			.prepare(`SELECT * FROM presence WHERE session_file = ?`)
			.get(sessionFile) as PresenceRow | undefined;
		return row ? this.toPresence(row) : null;
	}

	isLive(sessionFile: string): boolean {
		return this.presence(sessionFile)?.live ?? false;
	}

	list(filter: ListFilter = {}): Presence[] {
		const rows = this.db
			.prepare(`SELECT * FROM presence ORDER BY updated_at DESC`)
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
			throw new KenningError(
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
					text: `kenning: the role ${role} was taken over by ${sessionFile}. You no longer hold it; messages to ${role} now go there.`,
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
			throw new KenningError(
				`ambiguous target ${JSON.stringify(t)}: ${matches.map((m) => m.session_file).join(', ')}`,
				'ambiguous',
				matches.map((m) => m.session_file),
			);
		// A role nobody holds yet still resolves (the message waits for its next
		// holder), but only when it looks like one, so a typo is not silently queued.
		if (ROLE_RE.test(t) && /[/:]/.test(t))
			return {kind: 'role', target: t, session: null};
		throw new KenningError(
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
		if (!text.trim()) throw new KenningError('a message needs text', 'empty');
		if (Buffer.byteLength(text) > MAX_TEXT_BYTES)
			throw new KenningError(
				`message is over 8 KB (${Buffer.byteLength(text)} bytes): put the content in git (a branch, a commit, a plan section) and send a pointer to it`,
				'too-large',
			);
		const origin = input.origin ?? (input.from ? 'agent' : 'human');
		if (origin === 'human-relayed' && !input.relay)
			throw new KenningError(
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
		if (!row) throw new KenningError(`no message ${id}`, 'not-found');
		if (row.from_session !== from)
			throw new KenningError(`message ${id} is not yours`, 'not-yours');
		if (row.state !== 'pending')
			throw new KenningError(
				`message ${id} is already ${row.state}`,
				row.state,
			);
		if (this.isClaimed(row))
			throw new KenningError(
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
			throw new KenningError(`no question ${input.questionId}`, 'not-found');
		if (q.state !== 'open')
			throw new KenningError(`question ${q.id} is already ${q.state}`, q.state);
		if (input.from !== null) {
			const addressee =
				q.to.kind === 'session' ? q.to.target : this.roleHolder(q.to.target);
			if (addressee !== input.from)
				throw new KenningError(
					`question ${q.id} was not asked of ${input.from}`,
					'not-asked',
				);
		}
		const origin = input.origin ?? (input.from ? 'agent' : 'human');
		if (origin === 'human-relayed' && !input.relay)
			throw new KenningError(
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
			throw new KenningError(`no question ${input.questionId}`, 'not-found');
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
				throw new KenningError(
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
	 * (a slash command, the CLI at a terminal, a host's authenticated UI): ADR 0003.
	 */
	answerItem(itemId: string, text: string, opts: {channel: string}): Message {
		const item = this.item(itemId);
		if (!item) throw new KenningError(`no item ${itemId}`, 'not-found');
		if (item.state !== 'open')
			throw new KenningError(
				`item ${itemId} is already ${item.state}`,
				item.state,
			);
		const t = this.now();
		const relay: Relay = {
			text,
			channel: opts.channel,
			session: null,
			itemId,
			at: t,
		};
		const id = this.tx(() => {
			this.db
				.prepare(
					`UPDATE item SET state = 'answered', answer = ?, answer_channel = ?, finished_at = ? WHERE id = ?`,
				)
				.run(text, opts.channel, t, itemId);
			return this.insertMessage({
				from: null,
				fromLabel: 'human',
				to: {kind: 'session', target: item.session},
				kind: 'answer',
				text,
				origin: 'human',
				relay,
				itemId,
			});
		});
		return this.message(id)!;
	}

	withdrawItem(from: string, itemId: string): void {
		this.tx(() => {
			this.db
				.prepare(
					`UPDATE item SET state = 'withdrawn', finished_at = ? WHERE id = ? AND session_file = ? AND state = 'open'`,
				)
				.run(this.now(), itemId, from);
		});
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
	 * or a host's `kenning:human-input` mark. Never call this for agent text.
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
				throw new KenningError(
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
			throw new KenningError(
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
			wake: r.wake === 1,
			live: this.probe.isAlive(this.identityOf(r)),
			pid: r.pid,
			updatedAt: r.updated_at,
			settledAt: r.settled_at,
		};
	}
}

export function openKenning(opts: KenningOptions = {}): Kenning {
	return new Kenning(opts);
}
