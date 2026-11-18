import {Kenning} from './kenning.js';
import {readTail} from './tail.js';
import {KenningError, type AttentionItem, type Presence} from './types.js';

export interface CliIo {
	env: Record<string, string | undefined>;
	/** Whether stdin and stdout are a terminal: a precondition for acting as the human. */
	isTTY: boolean;
	stdout(s: string): void;
	stderr(s: string): void;
}

const USAGE = `kenning: sessions that know about each other

  kenning list [--cwd DIR] [--role ROLE] [--json]   live sessions
  kenning read TARGET                               presence, open questions, recent transcript
  kenning tell TARGET TEXT...  [--urgent]           send a message
  kenning ask TARGET QUESTION...                    ask a question
  kenning inbox [--json]                            the human's open attention items
  kenning answer ID TEXT...                         answer an inbox item (h_...) or a question (q_...)

TARGET is a role (template-tree/push), a session file (.jsonl) or a session-id prefix.
Run by a human at a terminal, tell, ask and answer are origin "human". Run from an
agent's bash (PI_SESSION_FILE is set) they come from that session, origin "agent",
and answer is refused: only the human answers the human's inbox.
State: $KENNING_STATE_DIR, else $XDG_STATE_HOME/kenning.
`;

function flags(args: string[]) {
	const rest: string[] = [];
	const opts: Record<string, string | true> = {};
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a.startsWith('--')) {
			const key = a.slice(2);
			if (['cwd', 'role'].includes(key)) opts[key] = args[++i] ?? '';
			else opts[key] = true;
		} else rest.push(a);
	}
	return {rest, opts};
}

/**
 * Who is speaking (ADR 0003). Inside an agent session the bash tool sets
 * PI_SESSION_FILE, so the CLI speaks as that session; a human is a terminal
 * with no session around it. Neither is proof against a determined agent on the
 * same user, which is the stated limit.
 */
function speaker(
	io: CliIo,
): {kind: 'agent'; session: string} | {kind: 'human'} | {kind: 'script'} {
	const session = io.env.PI_SESSION_FILE;
	if (session) return {kind: 'agent', session};
	if (io.isTTY) return {kind: 'human'};
	return {kind: 'script'};
}

function presenceLine(p: Presence): string {
	const bits = [
		p.roles.join(',') || '(no role)',
		p.state,
		p.cwd ?? '?',
		p.branch,
		p.status ? `status: ${p.status}` : null,
	].filter(Boolean);
	return `${p.sessionFile}\n  ${bits.join(' · ')}`;
}

function itemLine(i: AttentionItem): string {
	return `${i.id}${i.blocking ? ' BLOCKING' : ''}  ${i.question}${i.options?.length ? `  [${i.options.join(' / ')}]` : ''}\n  from ${i.session}`;
}

export function runCli(argv: string[], io: CliIo): number {
	const [cmd, ...args] = argv;
	if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
		io.stdout(USAGE);
		return cmd ? 0 : 2;
	}
	const known = ['list', 'read', 'tell', 'ask', 'inbox', 'answer'];
	if (!known.includes(cmd)) {
		io.stderr(`kenning: unknown command ${cmd}\n\n${USAGE}`);
		return 2;
	}
	let k: Kenning | undefined;
	try {
		k = new Kenning({stateDir: io.env.KENNING_STATE_DIR || undefined});
		const {rest, opts} = flags(args);
		const who = speaker(io);
		const from = who.kind === 'agent' ? who.session : null;
		const origin = who.kind === 'human' ? 'human' : 'agent';
		switch (cmd) {
			case 'list': {
				const list = k.list({
					cwd: opts.cwd as string | undefined,
					role: opts.role as string | undefined,
				});
				if (opts.json) io.stdout(JSON.stringify(list, null, 2) + '\n');
				else
					io.stdout(
						list.length
							? list.map(presenceLine).join('\n') + '\n'
							: 'No live sessions.\n',
					);
				return 0;
			}
			case 'read': {
				const r = k.resolve(need(rest[0], 'TARGET'));
				if (!r.session) {
					io.stdout(`${r.target}: nobody holds this role right now.\n`);
					return 0;
				}
				const p = k.presence(r.session);
				const qs = k.openQuestionsTo(r.session);
				const tail = readTail(r.session);
				io.stdout(
					[
						p ? presenceLine(p) + (p.live ? '' : '  (GONE)') : r.session,
						qs.length
							? 'open questions:\n' +
								qs
									.map((q) => `  ${q.id} from ${q.askerLabel}: ${q.text}`)
									.join('\n')
							: null,
						tail.messages.map((m) => `[${m.role}] ${m.text}`).join('\n\n'),
					]
						.filter(Boolean)
						.join('\n\n') + '\n',
				);
				return 0;
			}
			case 'tell':
			case 'ask': {
				const target = need(rest[0], 'TARGET');
				const text = need(
					rest.slice(1).join(' '),
					cmd === 'ask' ? 'QUESTION' : 'TEXT',
				);
				const sent = k.send({
					from,
					fromLabel: who.kind === 'script' ? 'script' : undefined,
					to: target,
					text,
					kind: cmd,
					origin,
					urgent: opts.urgent === true,
				});
				io.stdout(
					`${cmd === 'ask' ? `asked ${sent.question!.id}` : 'sent'} as ${sent.message.id} (origin ${sent.message.origin})\n`,
				);
				return 0;
			}
			case 'inbox': {
				const items = k.inbox();
				if (opts.json) io.stdout(JSON.stringify(items, null, 2) + '\n');
				else
					io.stdout(
						items.length
							? items.map(itemLine).join('\n') + '\n'
							: 'The inbox is empty.\n',
					);
				return 0;
			}
			case 'answer': {
				if (who.kind === 'agent')
					throw new KenningError(
						'answer is refused from inside an agent session (PI_SESSION_FILE is set): only the human answers as the human',
						'not-human',
					);
				if (who.kind !== 'human')
					throw new KenningError(
						'answer needs a terminal: only the human, at their terminal, answers as the human',
						'not-human',
					);
				const id = need(rest[0], 'ID');
				const text = need(rest.slice(1).join(' '), 'TEXT');
				if (id.startsWith('h_')) k.answerItem(id, text, {channel: 'cli'});
				else k.answer({from: null, questionId: id, text, origin: 'human'});
				io.stdout(`answered ${id}\n`);
				return 0;
			}
		}
		return 2;
	} catch (e) {
		if (e instanceof KenningError) {
			io.stderr(`kenning: ${e.message}\n`);
			return 1;
		}
		throw e;
	} finally {
		k?.close();
	}
}

function need(v: string | undefined, what: string): string {
	if (!v || !v.trim()) throw new KenningError(`missing ${what}`, 'usage');
	return v;
}
