import {
	planDelivery,
	SESSION_ANSWER_CHANNEL,
	type HumanInputMark,
	type Shipmates,
	type Message,
	type SessionState,
} from 'shipmates';
import type {
	ExtensionAPI,
	ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {formatDelivery} from './format.js';
import {acquire, release} from './shared.js';
import {inWhereverServer, mayBeTerminalHuman, mayWakeItself} from './mode.js';
import {
	SPAWN_ENV,
	WAKE_GAP_MS,
	WAKE_LEASE_MS,
	planWake,
	startDetached,
} from './spawn.js';

export const CUSTOM_TYPE = 'shipmates';

/**
 * How long a host's `shipmates:human-input` mark stays valid (ADR 0003, D22). A
 * host emits it immediately before the send, and pi runs `input` handlers first
 * thing in `prompt()` and `sendUserMessage()`: measured mark-to-`input` latency
 * on pi 1.4 is about 0.1 ms (0.51 ms worst of 20 sends). A send that never
 * reaches the `input` handler (another extension returned `handled`, a terminal
 * pi refused it while compacting) must not leave a mark behind that a later
 * identical `extension` input, such as a scheduled `/standup`, would match. 5 s is
 * 10,000 times the worst measured latency, room for a loaded event loop, yet far
 * shorter than any schedule that could repeat the same text.
 *
 * The expiry is the backstop. A host that awaits its send closes the mark
 * itself with `shipmates:human-input-end` (D35), which leaves no window at all;
 * a host that cannot (an extension's fire-and-forget `pi.sendUserMessage()`,
 * like the @wherever-dev/pi bridge) relies on this. The real fix is pi
 * carrying an origin on the send: earendil-works/pi#12291.
 */
export const HUMAN_MARK_TTL_MS = 5_000;

type Boundary = {
	entries: {
		type: 'custom_message';
		customType: string;
		content: string;
		display: boolean;
		details: unknown;
	}[];
	continue: boolean;
};
export const ROLE_ENTRY = 'shipmates-role';

type Entry = {
	type: string;
	customType?: string;
	details?: unknown;
	data?: unknown;
	message?: {role?: string; customType?: string; details?: unknown};
};

/**
 * One pi session as shipmates sees it: its presence, and the delivery of its
 * mailbox at the moments ADR 0002 allows. pi calls the factory again for every
 * session (startup, /new, /resume, /fork, reload), so this lives per session.
 */
export class SessionController {
	shipmates: Shipmates | undefined;
	file: string | undefined;
	private ctx: ExtensionContext | undefined;
	private phase: 'running' | 'settled' = 'settled';
	private uiPrompt = false;
	/**
	 * session_register({state: 'waiting-for-human'}), or a human_ask timeout,
	 * and no run since (ADR 0006). Kept in shipmates per transcript file, so an
	 * unload and a reload (wherever's pool, a resume) still hold agent messages
	 * for the human (D40). Change it with declareWaiting.
	 */
	declaredWaiting = false;
	/** Inside session_wait or a blocking human_ask: the tool does its own reporting. */
	toolState: SessionState | null = null;
	/**
	 * The item a blocking human_ask of this session is waiting on (D39), and
	 * whether it waits in a TUI dialog (the human answers there) or by polling
	 * the inbox (a human reply in this session then answers it).
	 */
	waitingItem: {id: string; dialog: boolean} | null = null;
	private humanMarks: (HumanInputMark & {at: number})[] = [];
	/** When the current run started (shipmates' clock), for stop requests (D30). */
	private runStartedAt = 0;
	/**
	 * Set when a run ends aborted (Esc, or a stop): messages already pending then
	 * wait for the next run instead of waking the session at once, or a stop
	 * would undo itself (D30). Cleared when a run starts.
	 */
	private abortedAt: number | null = null;
	/** The current run was aborted by a stop request (D30), not by a shutdown or a host. */
	stoppedByRequest = false;
	private readonly listener = {onChange: () => this.onChange()};

	constructor(private readonly pi: ExtensionAPI) {}

	get active(): boolean {
		return !!this.shipmates && !!this.file;
	}

	/** Ids already in this session's transcript: what "delivered" means (D5). */
	private reconcile(): void {
		if (!this.active || !this.ctx) return;
		const branch = this.ctx.sessionManager.getBranch() as unknown as Entry[];
		const ids: string[] = [];
		for (
			let i = branch.length - 1, seen = 0;
			i >= 0 && seen < 400;
			i--, seen++
		) {
			const e = branch[i];
			const details =
				e.type === 'custom_message' && e.customType === CUSTOM_TYPE
					? e.details
					: e.type === 'message' &&
						  e.message?.role === 'custom' &&
						  e.message.customType === CUSTOM_TYPE
						? e.message.details
						: undefined;
			const got = (details as {ids?: unknown} | undefined)?.ids;
			if (Array.isArray(got))
				ids.push(...got.filter((x): x is string => typeof x === 'string'));
		}
		if (ids.length) this.shipmates!.markDelivered(this.file!, ids);
	}

	// ------------------------------------------------------------- lifecycle

	start(ctx: ExtensionContext): void {
		this.ctx = ctx;
		if (process.env.PI_SUBAGENT_CHILD === '1') return; // D7: dormant in milestone 1
		const file = ctx.sessionManager.getSessionFile();
		if (!file) return; // --no-session: nothing to address
		this.shipmates = acquire(this.listener);
		this.file = file;
		const me = this.shipmates.register({
			sessionFile: file,
			sessionId: ctx.sessionManager.getSessionId(),
			cwd: ctx.cwd,
		});
		this.declaredWaiting = me.declaredWaiting;
		this.bindSpawn(file);
		this.reconcile();
		this.reclaimRole(ctx);
		void this.refreshBranch();
		this.onChange();
	}

	shutdown(): void {
		clearTimeout(this.recheck);
		this.recheck = undefined;
		if (this.shipmates && this.file) {
			try {
				// Read everything: the next wake may come at once. Something still
				// pending keeps the gap, so a child that cannot read is retried slowly.
				if (!this.shipmates.pendingFor(this.file).length)
					this.shipmates.wakeDone(this.file, 0);
				this.declareIfCutOff();
				this.shipmates.unregister(this.file);
			} catch {}
			release(this.listener);
		}
		this.shipmates = undefined;
		this.file = undefined;
		this.ctx = undefined;
	}

	/**
	 * A terminal child shipmates spawned binds itself to its spawn, once (D28):
	 * this queues the owner's first prompt before `before_agent_start`. The
	 * variable is removed so nothing this process starts inherits it.
	 */
	private bindSpawn(file: string): void {
		const spawnId = process.env[SPAWN_ENV];
		if (spawnId) {
			delete process.env[SPAWN_ENV];
			try {
				this.shipmates!.bindSpawn(spawnId, file);
			} catch (e) {
				this.notify(`shipmates: ${(e as Error).message}`, 'warning');
			}
		}
		// Up: a headless wake that started us is done (D29).
		this.shipmates!.wakeDone(file, WAKE_GAP_MS);
	}

	/** A resumed session re-claims the role it held; a fork (a copy in a new file) does not (D9). */
	private reclaimRole(ctx: ExtensionContext): void {
		const flagRole =
			(this.pi.getFlag('shipmates-role') as string | undefined) ||
			process.env.SHIPMATES_ROLE;
		const roles = new Set<string>();
		for (const e of ctx.sessionManager.getBranch() as unknown as Entry[]) {
			if (e.type !== 'custom' || e.customType !== ROLE_ENTRY) continue;
			const d = e.data as
				{role?: string; sessionFile?: string; released?: boolean} | undefined;
			if (!d?.role || d.sessionFile !== this.file) continue;
			if (d.released) roles.delete(d.role);
			else roles.add(d.role);
		}
		if (flagRole) roles.add(flagRole);
		// A spawned session's role is part of its ownership record (D23).
		const spawnedAs = this.shipmates!.ownership(this.file!)?.role;
		if (spawnedAs) roles.add(spawnedAs);
		for (const role of roles) {
			try {
				const r = this.shipmates!.claimRole(this.file!, role);
				if (!r.ok)
					this.notify(
						`shipmates: role ${role} is held by a live session (${r.holder}); not taken.`,
						'warning',
					);
				else if (role === flagRole) this.recordRole(role);
			} catch (e) {
				this.notify(`shipmates: ${(e as Error).message}`, 'warning');
			}
		}
	}

	/**
	 * A blocking human_ask cut off before its answer (the session shut down, or a
	 * host aborted the run) leaves the session waiting for the human, as a
	 * timeout does (D39), so it is declared, and kept across the reload (D40).
	 * Not after a stop request: the owner stopped it to redirect it, and its next
	 * message must wake it. Called from the tool when it sees the abort, and from
	 * shutdown in case shutdown comes first (a host aborts, then shuts down).
	 */
	declareIfCutOff(): void {
		const w = this.waitingItem;
		if (!w || w.dialog || this.stoppedByRequest || !this.active) return;
		if (this.shipmates!.item(w.id)?.state === 'open') this.declareWaiting(true);
	}

	/** Declare (or clear) waiting-for-human; written through only when it changes. */
	declareWaiting(on: boolean): void {
		if (this.declaredWaiting === on) return;
		this.declaredWaiting = on;
		if (this.active) this.shipmates!.update(this.file!, {declaredWaiting: on});
	}

	recordRole(role: string): void {
		this.pi.appendEntry(ROLE_ENTRY, {role, sessionFile: this.file});
	}

	private async refreshBranch(): Promise<void> {
		if (!this.active || !this.ctx) return;
		try {
			const r = await this.pi.exec(
				'git',
				['-C', this.ctx.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'],
				{timeout: 3000},
			);
			if (r.code === 0 && this.active)
				this.shipmates!.update(this.file!, {branch: r.stdout.trim() || null});
		} catch {}
	}

	private setState(state: SessionState): void {
		if (this.active) this.shipmates!.update(this.file!, {state});
	}

	onAgentStart(ctx: ExtensionContext): void {
		this.ctx = ctx;
		this.phase = 'running';
		this.abortedAt = null;
		this.stoppedByRequest = false;
		if (this.active) this.runStartedAt = this.shipmates!.now();
		this.setState('running');
	}

	onSettled(ctx: ExtensionContext): void {
		this.ctx = ctx;
		this.phase = 'settled';
		if (!this.active) return;
		this.reconcile();
		this.setState(this.declaredWaiting ? 'waiting-for-human' : 'idle');
		void this.refreshBranch();
		this.onChange();
	}

	onUiPrompt(open: boolean): void {
		this.uiPrompt = open;
		if (this.toolState) return;
		this.setState(
			open
				? 'waiting-for-human'
				: this.phase === 'running'
					? 'running'
					: 'idle',
		);
	}

	setToolState(
		state: SessionState | null,
		waitingOn: string | null = null,
	): void {
		this.toolState = state;
		if (!this.active) return;
		this.shipmates!.update(this.file!, {state: state ?? 'running', waitingOn});
	}

	// ------------------------------------------------------------ human input

	/** Drop marks older than HUMAN_MARK_TTL_MS. A monotonic clock: a wall-clock jump must not revive one. */
	private dropExpiredMarks(): void {
		const oldest = performance.now() - HUMAN_MARK_TTL_MS;
		this.humanMarks = this.humanMarks.filter((m) => m.at >= oldest);
	}

	onHumanMark(data: unknown): void {
		this.dropExpiredMarks();
		const m = data as Partial<HumanInputMark> | undefined;
		if (typeof m?.text === 'string' && typeof m.channel === 'string')
			this.humanMarks.push({
				text: m.text,
				channel: m.channel,
				id: typeof m.id === 'string' ? m.id : undefined,
				at: performance.now(),
			});
		if (this.humanMarks.length > 20) this.humanMarks.shift();
	}

	/**
	 * The host's marked send has settled (D35): drop its mark if no input took
	 * it. By id when the mark had one, else the oldest open mark with this text.
	 * A mark already consumed is not here, so a late end is a no-op.
	 */
	onHumanMarkEnd(data: unknown): void {
		this.dropExpiredMarks();
		const e = data as {text?: unknown; id?: unknown} | undefined;
		const i =
			typeof e?.id === 'string'
				? this.humanMarks.findIndex((m) => m.id === e.id)
				: typeof e?.text === 'string'
					? this.humanMarks.findIndex((m) => m.text === e.text && !m.id)
					: -1;
		if (i >= 0) this.humanMarks.splice(i, 1);
	}

	/**
	 * ADR 0003: TUI typing, or an input a host marked as human just before
	 * sending it. A human turn also answers this session's open inbox items
	 * (D39). Returns true when the input was consumed as the answer a blocking
	 * human_ask is waiting for, so pi must not also queue it.
	 */
	onInput(text: string, source: string, hasImages = false): boolean {
		if (!this.active) return false;
		let channel: string | null = null;
		if (source === 'interactive') {
			if (this.typedAtTerminal()) channel = 'terminal';
		} else if (source === 'extension') {
			this.dropExpiredMarks();
			const i = this.humanMarks.findIndex((m) => m.text === text);
			if (i >= 0) channel = this.humanMarks.splice(i, 1)[0].channel;
		}
		if (!channel) return false;
		this.shipmates!.recordHumanTurn(this.file!, {text, channel});
		// pi expands `/skill:` and prompt templates after the input handlers: a
		// command is not an answer to anything (extension commands never get here).
		if (text.trimStart().startsWith('/')) return false;
		return this.answerFromSession(text, hasImages);
	}

	/**
	 * D39: the human replied in this session, so every item it raised and that
	 * is still open is answered with their words, on channel `session`. When a
	 * blocking human_ask polls for one of them, that one is answered with a
	 * message (the tool returns it as its result and marks it delivered, and if
	 * the tool is gone the message is delivered like any answer) and the input
	 * is consumed. Every other item closes with no message: the human's words
	 * are in this session's turn already; one notice names the items they
	 * closed, so the agent knows which questions are settled. An input with images is not consumed
	 * (the tool result cannot carry them), so it also joins the turn as usual.
	 */
	private answerFromSession(text: string, hasImages: boolean): boolean {
		const k = this.shipmates!;
		const w = this.waitingItem;
		let consumed = false;
		if (w && !w.dialog && k.item(w.id)?.state === 'open') {
			try {
				k.answerItem(w.id, text, {
					channel: SESSION_ANSWER_CHANNEL,
					deliver: !hasImages,
				});
				consumed = !hasImages;
			} catch {} // answered elsewhere at the same moment: the tool reports that
		}
		k.answerOpenItemsOf(this.file!, text, {
			channel: SESSION_ANSWER_CHANNEL,
			deliver: false,
			notice: true,
			// A TUI dialog is answered in the dialog, not by typing elsewhere.
			except: w?.dialog ? [w.id] : [],
		});
		return consumed;
	}

	/**
	 * pi reports `pi -p TEXT` as source `interactive` too (print mode calls
	 * `prompt()` with the default source), so outside the TUI the source alone
	 * proves nothing: a headless child shipmates spawned, a cron job or an agent's
	 * bash running `pi -p "I approve"` would all count as the human (D27). Outside
	 * the TUI it is the human only under the CLI's rule (D2): a terminal on stdin
	 * and no agent session around it. Inside wherever, never (D36).
	 */
	private typedAtTerminal(): boolean {
		return mayBeTerminalHuman({
			mode: this.ctx?.mode ?? 'print',
			inWhereverServer: inWhereverServer(),
			stdinIsTTY: !!process.stdin.isTTY,
			inAgentSession: !!process.env.PI_SESSION_FILE,
		});
	}

	// ---------------------------------------------------------------- delivery

	/** Anything changed in the database: maybe stop, wake a child, wake, update the notices. */
	private onChange(): void {
		if (!this.active || !this.ctx) return;
		try {
			this.handleStops();
			this.wakeOwned();
			this.refreshNotices();
			// A real `pi -p` run never wakes itself (D29); a print-mode session in
			// wherever's server does, or nothing would deliver to it (D36).
			if (
				!mayWakeItself({
					mode: this.ctx.mode,
					inWhereverServer: inWhereverServer(),
				})
			)
				return;
			if (this.phase !== 'settled' || !this.ctx.isIdle()) return;
			const since = this.abortedAt ?? -Infinity;
			const pending = this.shipmates!.pendingFor(this.file!).filter(
				(m) => m.createdAt > since,
			);
			if (!pending.length) return;
			const presence = this.shipmates!.presence(this.file!);
			const plan = planDelivery(
				{
					phase: 'settled',
					declared: presence?.state ?? 'idle',
					uiPrompt: this.uiPrompt,
					editorBusy: this.editorBusy(),
					wake: presence?.wake ?? true,
				},
				{
					urgent: pending.some((m) => m.urgent),
					fromHuman: pending.some((m) => m.origin === 'human'),
				},
			);
			if (plan === 'wake') this.wake();
		} catch (e) {
			console.error('[shipmates] delivery failed:', e);
		}
	}

	/**
	 * D30: a stop request for this session aborts the run that was going when it
	 * was made, and only that; one made while settled, or before this run began,
	 * is answered `not-running`. A read per poll; the write only when there is one.
	 */
	private handleStops(): void {
		const k = this.shipmates!;
		for (const req of k.openStops(this.file!)) {
			const running = this.phase === 'running' && this.runStartedAt <= req.at;
			if (running) {
				this.stoppedByRequest = true;
				this.ctx!.abort();
			}
			k.settleStop(req.id, running ? 'stopped' : 'not-running');
		}
	}

	/**
	 * D29: this session's headless children are `pi -p` runs that exit when
	 * done. When one is not running and has messages that arrived after its last
	 * stop, start `pi --session <path> -p` for it, under a lease so no two polls
	 * or processes start it twice. Only the owner wakes a child.
	 */
	private wakeOwned(): void {
		const k = this.shipmates!;
		for (const o of k.wakeCandidates(this.file!)) {
			const child = o.session!;
			if (k.isLive(child)) continue;
			const lease = k.leaseWake(child, WAKE_LEASE_MS);
			if (!lease.ok) {
				// Nothing may change in the database when the lease lapses: look again then.
				if (lease.until) this.recheckAt(lease.until);
				continue;
			}
			startDetached(
				planWake({env: process.env, sessionFile: child, folder: o.folder}),
				o.id,
			).catch((e) =>
				this.notify(
					`shipmates: could not wake ${child}: ${(e as Error).message}`,
					'warning',
				),
			);
		}
	}

	private recheck: ReturnType<typeof setTimeout> | undefined;
	private recheckAt(at: number): void {
		if (this.recheck) return;
		const ms = Math.max(at - this.shipmates!.now(), 0) + 50;
		this.recheck = setTimeout(() => {
			this.recheck = undefined;
			this.onChange();
		}, ms);
		this.recheck.unref();
	}

	private editorBusy(): boolean {
		if (!this.ctx || this.ctx.mode !== 'tui') return false;
		try {
			return this.ctx.ui.getEditorText().trim().length > 0;
		} catch {
			return false;
		}
	}

	/** Claim what can be delivered now, after making sure nothing is claimed twice. */
	private take(filter: (m: Message) => boolean = () => true): Message[] {
		if (!this.active) return [];
		this.reconcile();
		const ids = this.shipmates!.pendingFor(this.file!)
			.filter(filter)
			.map((m) => m.id);
		return ids.length ? this.shipmates!.claim(this.file!, {ids}) : [];
	}

	private payload(messages: Message[], woken: boolean) {
		return {
			customType: CUSTOM_TYPE as string,
			content: formatDelivery(messages, {woken}),
			display: true,
			details: {
				ids: messages.map((m) => m.id),
				from: messages.map((m) => m.fromLabel),
				origins: messages.map((m) => m.origin),
			},
		};
	}

	/** Deliver now into an idle session: it starts a turn. */
	wake(opts: {woken?: boolean} = {}): boolean {
		const messages = this.take();
		if (!messages.length) return false;
		this.phase = 'running';
		this.pi.sendMessage(this.payload(messages, opts.woken ?? true), {
			triggerTurn: true,
		});
		return true;
	}

	/** before_agent_start: attach everything held to the run the human (or anyone) just started. */
	beforeAgentStart(): ReturnType<SessionController['payload']> | undefined {
		this.declareWaiting(false);
		const messages = this.take();
		return messages.length ? this.payload(messages, false) : undefined;
	}

	/** turn_end: urgent messages, and everything held while a dialog was open. */
	atTurnEnd(aborted = false): Boundary | undefined {
		if (aborted) return undefined; // a stopped turn must not be continued (D30)
		const messages = this.take((m) => m.urgent || this.uiPrompt);
		if (!messages.length) return undefined;
		return {
			entries: [
				{type: 'custom_message' as const, ...this.payload(messages, false)},
			],
			continue: true,
		};
	}

	/** agent_before_settle: everything that arrived during the run, read before stopping. */
	atSettle(outcome?: string): Boundary | undefined {
		if (outcome === 'aborted') {
			// Esc or a stop: continuing would undo it. What is pending waits (D30).
			this.abortedAt = this.active ? this.shipmates!.now() : Date.now();
			return undefined;
		}
		if (this.declaredWaiting) return undefined; // it just said it waits for the human: hold
		const messages = this.take();
		if (!messages.length) return undefined;
		return {
			entries: [
				{type: 'custom_message' as const, ...this.payload(messages, false)},
			],
			continue: true,
		};
	}

	onTurnStart(): void {
		this.reconcile();
	}

	onCustomMessageEnd(): void {
		this.reconcile();
		this.refreshNotices();
	}

	// ----------------------------------------------------------------- notices

	private lastWidget = '';
	private lastBadge = '';

	/** A widget for messages held for the human, and an inbox badge (D3, D13). */
	refreshNotices(): void {
		if (!this.active || !this.ctx || !this.ctx.hasUI || this.ctx.mode !== 'tui')
			return;
		const held =
			this.phase === 'settled' ? this.shipmates!.pendingFor(this.file!) : [];
		const widget = held.length
			? `shipmates: ${held.length} message${held.length === 1 ? '' : 's'} waiting (from ${[...new Set(held.map((m) => m.fromLabel))].join(', ')}). They join your next message; /shipmates deliver reads them now.`
			: '';
		if (widget !== this.lastWidget) {
			this.ctx.ui.setWidget('shipmates', widget ? [widget] : undefined);
			this.lastWidget = widget;
		}
		const items = this.shipmates!.inbox().length;
		const badge = items ? `shipmates: ${items} for you (/shipmates inbox)` : '';
		if (badge !== this.lastBadge) {
			this.ctx.ui.setStatus('shipmates', badge || undefined);
			this.lastBadge = badge;
		}
	}

	notify(text: string, level: 'info' | 'warning' | 'error' = 'info'): void {
		if (this.ctx?.hasUI) this.ctx.ui.notify(text, level);
		else console.error(text);
	}
}
