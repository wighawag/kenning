import {
	planDelivery,
	type HumanInputMark,
	type Kenning,
	type Message,
	type SessionState,
} from 'kenning';
import type {
	ExtensionAPI,
	ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {formatDelivery} from './format.js';
import {acquire, release} from './shared.js';

export const CUSTOM_TYPE = 'kenning';

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
export const ROLE_ENTRY = 'kenning-role';

type Entry = {
	type: string;
	customType?: string;
	details?: unknown;
	data?: unknown;
	message?: {role?: string; customType?: string; details?: unknown};
};

/**
 * One pi session as kenning sees it: its presence, and the delivery of its
 * mailbox at the moments ADR 0002 allows. pi calls the factory again for every
 * session (startup, /new, /resume, /fork, reload), so this lives per session.
 */
export class SessionController {
	kenning: Kenning | undefined;
	file: string | undefined;
	private ctx: ExtensionContext | undefined;
	private phase: 'running' | 'settled' = 'settled';
	private uiPrompt = false;
	/** session_register({state: 'waiting-for-human'}) during this run (ADR 0006). */
	declaredWaiting = false;
	/** Inside session_wait or a blocking human_ask: the tool does its own reporting. */
	toolState: SessionState | null = null;
	private humanMarks: HumanInputMark[] = [];
	private readonly listener = {onChange: () => this.onChange()};

	constructor(private readonly pi: ExtensionAPI) {}

	get active(): boolean {
		return !!this.kenning && !!this.file;
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
		if (ids.length) this.kenning!.markDelivered(this.file!, ids);
	}

	// ------------------------------------------------------------- lifecycle

	start(ctx: ExtensionContext): void {
		this.ctx = ctx;
		if (process.env.PI_SUBAGENT_CHILD === '1') return; // D7: dormant in milestone 1
		const file = ctx.sessionManager.getSessionFile();
		if (!file) return; // --no-session: nothing to address
		this.kenning = acquire(this.listener);
		this.file = file;
		this.kenning.register({
			sessionFile: file,
			sessionId: ctx.sessionManager.getSessionId(),
			cwd: ctx.cwd,
		});
		this.reconcile();
		this.reclaimRole(ctx);
		void this.refreshBranch();
		this.onChange();
	}

	shutdown(): void {
		if (this.kenning && this.file) {
			try {
				this.kenning.unregister(this.file);
			} catch {}
			release(this.listener);
		}
		this.kenning = undefined;
		this.file = undefined;
		this.ctx = undefined;
	}

	/** A resumed session re-claims the role it held; a fork (a copy in a new file) does not (D9). */
	private reclaimRole(ctx: ExtensionContext): void {
		const flagRole =
			(this.pi.getFlag('kenning-role') as string | undefined) ||
			process.env.KENNING_ROLE;
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
		for (const role of roles) {
			try {
				const r = this.kenning!.claimRole(this.file!, role);
				if (!r.ok)
					this.notify(
						`kenning: role ${role} is held by a live session (${r.holder}); not taken.`,
						'warning',
					);
				else if (role === flagRole) this.recordRole(role);
			} catch (e) {
				this.notify(`kenning: ${(e as Error).message}`, 'warning');
			}
		}
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
				this.kenning!.update(this.file!, {branch: r.stdout.trim() || null});
		} catch {}
	}

	private setState(state: SessionState): void {
		if (this.active) this.kenning!.update(this.file!, {state});
	}

	onAgentStart(ctx: ExtensionContext): void {
		this.ctx = ctx;
		this.phase = 'running';
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
		this.kenning!.update(this.file!, {state: state ?? 'running', waitingOn});
	}

	// ------------------------------------------------------------ human input

	onHumanMark(data: unknown): void {
		const m = data as Partial<HumanInputMark> | undefined;
		if (typeof m?.text === 'string' && typeof m.channel === 'string')
			this.humanMarks.push({text: m.text, channel: m.channel});
		if (this.humanMarks.length > 20) this.humanMarks.shift();
	}

	/** ADR 0003: TUI typing, or an input a host marked as human just before sending it. */
	onInput(text: string, source: string): void {
		if (!this.active) return;
		if (source === 'interactive') {
			this.kenning!.recordHumanTurn(this.file!, {text, channel: 'terminal'});
			return;
		}
		if (source !== 'extension') return;
		const i = this.humanMarks.findIndex((m) => m.text === text);
		if (i < 0) return;
		const [mark] = this.humanMarks.splice(i, 1);
		this.kenning!.recordHumanTurn(this.file!, {text, channel: mark.channel});
	}

	// ---------------------------------------------------------------- delivery

	/** Anything changed in the database: maybe wake, maybe update the notices. */
	private onChange(): void {
		if (!this.active || !this.ctx) return;
		try {
			this.refreshNotices();
			if (this.phase !== 'settled' || !this.ctx.isIdle()) return;
			const pending = this.kenning!.pendingFor(this.file!);
			if (!pending.length) return;
			const presence = this.kenning!.presence(this.file!);
			const plan = planDelivery(
				{
					phase: 'settled',
					declared: presence?.state ?? 'idle',
					uiPrompt: this.uiPrompt,
					editorBusy: this.editorBusy(),
					wake: presence?.wake ?? true,
				},
				{urgent: pending.some((m) => m.urgent)},
			);
			if (plan === 'wake') this.wake();
		} catch (e) {
			console.error('[kenning] delivery failed:', e);
		}
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
		const ids = this.kenning!.pendingFor(this.file!)
			.filter(filter)
			.map((m) => m.id);
		return ids.length ? this.kenning!.claim(this.file!, {ids}) : [];
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
		this.declaredWaiting = false;
		const messages = this.take();
		return messages.length ? this.payload(messages, false) : undefined;
	}

	/** turn_end: urgent messages, and everything held while a dialog was open. */
	atTurnEnd(): Boundary | undefined {
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
	atSettle(): Boundary | undefined {
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
			this.phase === 'settled' ? this.kenning!.pendingFor(this.file!) : [];
		const widget = held.length
			? `kenning: ${held.length} message${held.length === 1 ? '' : 's'} waiting (from ${[...new Set(held.map((m) => m.fromLabel))].join(', ')}). They join your next message; /kenning deliver reads them now.`
			: '';
		if (widget !== this.lastWidget) {
			this.ctx.ui.setWidget('kenning', widget ? [widget] : undefined);
			this.lastWidget = widget;
		}
		const items = this.kenning!.inbox().length;
		const badge = items ? `kenning: ${items} for you (/kenning inbox)` : '';
		if (badge !== this.lastBadge) {
			this.ctx.ui.setStatus('kenning', badge || undefined);
			this.lastBadge = badge;
		}
	}

	notify(text: string, level: 'info' | 'warning' | 'error' = 'info'): void {
		if (this.ctx?.hasUI) this.ctx.ui.notify(text, level);
		else console.error(text);
	}
}
