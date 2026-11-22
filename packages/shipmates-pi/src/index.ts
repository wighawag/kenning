import {
	HUMAN_INPUT_END_EVENT,
	HUMAN_INPUT_EVENT,
	silenceSqliteWarning,
} from 'shipmates';
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {formatItem, formatOwnership, formatPresence} from './format.js';
import {CUSTOM_TYPE, SessionController} from './session.js';
import {registerTools} from './tools.js';

/**
 * shipmates as a pi extension: sessions that know about each other.
 *
 * Delivery happens only at pi's boundary hooks (ADR 0002): before_agent_start
 * (attach what was held for the human), turn_end (urgent), agent_before_settle
 * (read before stopping), and sendMessage with triggerTurn for an idle session.
 * Nothing goes into pi's own queues, so a message can be superseded or withdrawn
 * until the moment it enters the transcript.
 */
silenceSqliteWarning();

export default function extension(pi: ExtensionAPI): void {
	const ctl = new SessionController(pi);

	pi.registerFlag('shipmates-role', {
		type: 'string',
		description:
			'shipmates: claim this role for the session at startup (e.g. template-tree/push)',
	});

	pi.on('session_start', (_event, ctx) => {
		ctl.start(ctx);
	});
	pi.on('session_shutdown', () => {
		ctl.shutdown();
	});

	// A host marks the human input it is about to send (ADR 0003, D22).
	pi.events.on(HUMAN_INPUT_EVENT, (data) => ctl.onHumanMark(data));
	pi.events.on(HUMAN_INPUT_END_EVENT, (data) => ctl.onHumanMarkEnd(data));
	pi.on('input', (event) => {
		// `handled`: the human's reply became a waiting human_ask's result (D39).
		// pi runs input handlers before it queues a steer or follow-up, also
		// while a tool runs, so nothing reaches pi's queues (measured, pi 1.4).
		const handled = ctl.onInput(
			event.text,
			event.source,
			!!event.images?.length,
		);
		return {action: handled ? 'handled' : 'continue'};
	});

	pi.on('before_agent_start', (event) => {
		// A run shipmates itself started already carries its messages.
		if (
			event.messageType === 'custom' &&
			event.message.customType === CUSTOM_TYPE
		) {
			ctl.declaredWaiting = false;
			return;
		}
		const message = ctl.beforeAgentStart();
		return message ? {message} : undefined;
	});
	pi.on('agent_start', (_event, ctx) => ctl.onAgentStart(ctx));
	pi.on('turn_start', () => ctl.onTurnStart());
	pi.on('turn_end', (event) => ctl.atTurnEnd(event.outcome === 'aborted'));
	pi.on('agent_before_settle', (event) => ctl.atSettle(event.outcome));
	pi.on('agent_settled', (_event, ctx) => ctl.onSettled(ctx));
	pi.on('message_end', (event) => {
		const m = event.message as {role?: string; customType?: string};
		if (m.role === 'custom' && m.customType === CUSTOM_TYPE)
			ctl.onCustomMessageEnd();
	});
	pi.on('ui_prompt_start', () => ctl.onUiPrompt(true));
	pi.on('ui_prompt_end', () => ctl.onUiPrompt(false));

	registerTools(pi, ctl);

	pi.registerCommand('shipmates', {
		description:
			'shipmates: status | inbox (answer the human inbox) | deliver (read held messages now) | wake on|off',
		getArgumentCompletions: (prefix) =>
			['status', 'inbox', 'deliver', 'wake on', 'wake off']
				.filter((x) => x.startsWith(prefix))
				.map((value) => ({value, label: value})),
		async handler(args, ctx) {
			const k = ctl.shipmates;
			if (!ctl.active || !k) {
				ctx.ui.notify(
					'shipmates is not active in this session (no transcript, or a subagent child).',
					'warning',
				);
				return;
			}
			const [verb, arg] = args.trim().split(/\s+/);
			if (verb === 'wake') {
				k.update(ctl.file!, {wake: arg !== 'off'});
				ctx.ui.notify(
					`shipmates: messages ${arg === 'off' ? 'no longer start' : 'may start'} a turn in this session.`,
					'info',
				);
				return;
			}
			if (verb === 'deliver') {
				if (!ctx.isIdle()) {
					ctx.ui.notify(
						'shipmates: the agent is running; held messages are delivered before it settles.',
						'info',
					);
					return;
				}
				if (!ctl.wake({woken: false}))
					ctx.ui.notify('shipmates: nothing waiting.', 'info');
				return;
			}
			if (verb === 'inbox') {
				// The human answering in a slash command is a human act: the model
				// cannot invoke slash commands (ADR 0003).
				for (;;) {
					const items = k.inbox();
					if (!items.length) {
						ctx.ui.notify('shipmates: the inbox is empty.', 'info');
						break;
					}
					const labels = items.map((i) => formatItem(i).slice(0, 200));
					const pick = await ctx.ui.select(
						'shipmates inbox: pick an item to answer',
						labels,
					);
					if (pick === undefined) break;
					const item = items[labels.indexOf(pick)];
					const answer = item.options?.length
						? await ctx.ui.select(item.question, item.options)
						: await ctx.ui.input(item.question, 'your answer');
					if (answer === undefined) continue;
					k.answerItem(item.id, answer, {channel: 'terminal'});
					ctx.ui.notify(`shipmates: answered ${item.id}.`, 'info');
				}
				ctl.refreshNotices();
				return;
			}
			const me = k.presence(ctl.file!);
			const lines = [
				me ? formatPresence(me) : ctl.file!,
				...formatOwnership(k, ctl.file!),
				`held messages: ${k.pendingFor(ctl.file!).length}`,
				`open questions to you: ${k.openQuestionsTo(ctl.file!).length}`,
				`human inbox: ${k.inbox().length}`,
				`live sessions: ${k.list().length}`,
			];
			ctx.ui.notify(lines.join('\n'), 'info');
		},
	});
}
