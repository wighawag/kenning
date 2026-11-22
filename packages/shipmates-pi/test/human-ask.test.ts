import fs from 'node:fs';
import {openShipmates, type Shipmates} from 'shipmates';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {
	anyAlive,
	endWorld,
	newWorld,
	Pi,
	survivors,
	type World,
} from './harness.js';

// D39: human_ask blocks by default, and a human reply in the asking session
// answers its items. One long-lived print-mode session built as wherever's
// server builds one (D36), driven by sends like wherever's: marked as the
// human's (a `shipmates:human-input` mark, D22) or not (an agent, a schedule).
let w: World;
let host: Pi;
let file: string;
let k: Shipmates;
const OTHER = '/elsewhere/other.jsonl';

const quiet = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function eventually<T>(
	read: () => T,
	ok: (v: T) => boolean,
	ms = 10_000,
): Promise<T> {
	const end = Date.now() + ms;
	let v = read();
	while (!ok(v) && Date.now() < end) {
		await quiet(50);
		v = read();
	}
	return v;
}

/** Wake the session with a message from another session, as the brain's directive. */
const order = (text: string) => k.send({from: OTHER, to: file, text});

/**
 * A send as wherever makes it. Resolves with pi's preflight disposition once
 * the awaited prompt() settled (for a send that started a run: after the run).
 */
async function hostSend(
	text: string,
	opts: {channel?: string; source?: string} = {},
): Promise<string> {
	const from = host.mark();
	const id = host.send({type: 'send', text, ...opts});
	const what = text.slice(0, 30);
	const e = await host.waitFor((e) => e.type === 'preflight' && e.id === id, {
		from,
		what: `preflight of ${what}`,
	});
	const sent = await host.waitFor((e) => e.type === 'sent' && e.id === id, {
		from,
		what: `send of ${what}`,
	});
	expect(sent.error).toBeUndefined();
	return e.disposition;
}

type Msg = {role: string; content: unknown; customType?: string};
function messages(): Msg[] {
	return fs
		.readFileSync(file, 'utf8')
		.split('\n')
		.filter(Boolean)
		.map((l) => JSON.parse(l))
		.filter((e) => e.type === 'message' || e.type === 'custom_message')
		.map((e) =>
			e.type === 'message'
				? e.message
				: {role: 'custom', customType: e.customType, content: e.content},
		);
}
const textOf = (m: Msg) =>
	typeof m.content === 'string'
		? m.content
		: (m.content as {text?: string}[]).map((c) => c.text ?? '').join('\n');
const toolResults = (name: string) =>
	messages()
		.filter((m) => m.role === 'toolResult' && (m as any).toolName === name)
		.map((m) => ({text: textOf(m), isError: !!(m as any).isError}));
const stateIs = (want: string) =>
	eventually(
		() => k.presence(file)?.state,
		(s) => s === want,
	);
const results = (name: string, n: number) =>
	eventually(
		() => toolResults(name).length,
		(x) => x >= n,
	);

beforeAll(async () => {
	w = newWorld();
	host = Pi.startPrintHost(
		w,
		'asker',
		'DO session_register {"role":"w/asker","status":"started"}',
		{wherever: true},
	);
	file = (await host.waitFor((e) => e.type === 'ready', {what: 'asker ready'}))
		.sessionFile;
	k = openShipmates({stateDir: w.stateDir});
}, 60_000);

afterAll(async () => {
	k?.close();
	const procs = w.procs;
	const leaked = await endWorld(w);
	expect(leaked).toEqual([]);
	expect(anyAlive(procs)).toEqual([]);
	expect(survivors(w)).toEqual([]);
});

describe('human_ask in a long-lived print-mode session (D39)', () => {
	it("blocks by default, and the human's reply in the session is its result, not also queued", async () => {
		order('DO human_ask {"question":"Which branch?","timeoutSec":60}');
		const p = await eventually(
			() => k.presence(file),
			(p) => p?.state === 'waiting-for-human' && !!p.waitingOn,
		);
		const item = k.item(p!.waitingOn!)!;
		expect(item).toMatchObject({blocking: true, state: 'open'});

		// The human answers in wherever's chat while the tool waits: pi runs the
		// input handlers first, mid-tool, and shipmates consumes it.
		expect(await hostSend('main, please', {channel: 'web'})).toBe('handled');
		expect(k.item(item.id)).toMatchObject({
			state: 'answered',
			answer: 'main, please',
			answerChannel: 'session',
		});
		await results('human_ask', 1);
		expect(await stateIs('idle')).toBe('idle');
		const result = toolResults('human_ask').at(-1)!;
		expect(result.text).toContain('replying in this session');
		expect(result.text).toContain('main, please');
		// Not queued as a steer: the words are in the tool result only.
		expect(
			messages().filter(
				(m) => m.role === 'user' && textOf(m).includes('main, please'),
			),
		).toEqual([]);
		expect(k.pendingFor(file)).toEqual([]);
	});

	it('on timeout it declares waiting-for-human and tells the agent to end its turn', async () => {
		order('DO human_ask {"question":"Ship it?","timeoutSec":1}');
		await results('human_ask', 2);
		const result = toolResults('human_ask').at(-1)!;
		expect(result.text).toContain('END YOUR TURN NOW');
		expect(await stateIs('waiting-for-human')).toBe('waiting-for-human');
		// Waiting for the human, an agent's message is held (D3).
		order('DO session_register {"status":"agent ran"}');
		await quiet(1000);
		expect(k.presence(file)!.status).toBe('started');
		expect(k.pendingFor(file)).toHaveLength(1);
	});

	it("an agent's or a schedule's input never closes an item", async () => {
		const open = k.inbox().filter((i) => i.session === file);
		expect(open.map((i) => i.question)).toEqual(['Ship it?']);
		// Unmarked `extension` (an agent, a cron prompt), and `interactive` with
		// no mark (a `pi -p` inside wherever's server, D36).
		await hostSend('noted from a schedule', {source: 'extension'});
		await hostSend('noted from pi -p', {source: 'interactive'});
		expect(k.item(open[0].id)!.state).toBe('open');
	});

	it('after the turn closed, a human reply closes the open items with no duplicate answer message', async () => {
		const [item] = k.inbox().filter((i) => i.session === file);
		const before = messages().length;
		expect(
			await hostSend('DO session_register {"status":"ship: yes"}', {
				channel: 'telegram',
			}),
		).toBe('started');
		expect(k.item(item.id)).toMatchObject({
			state: 'answered',
			answerChannel: 'session',
			answer: 'DO session_register {"status":"ship: yes"}',
		});
		expect(k.presence(file)!.status).toBe('ship: yes');
		expect(k.pendingFor(file)).toEqual([]);
		// No answer message for the item: the human's words are the run's own
		// prompt. One notice tells the agent which item the reply closed.
		const added = messages()
			.slice(before)
			.filter((m) => m.role === 'custom');
		expect(added.filter((m) => textOf(m).includes('· answer'))).toEqual([]);
		expect(added.filter((m) => textOf(m).includes('ship: yes'))).toEqual([]);
		const notices = added.filter((m) => textOf(m).includes('· notice'));
		expect(notices).toHaveLength(1);
		expect(textOf(notices[0])).toContain(item.id);
	});

	it("a non-blocking item is closed by the human's next reply too", async () => {
		order('DO human_ask {"question":"Tag it?","blocking":false}');
		const item = (await eventually(
			() => k.inbox().find((i) => i.question === 'Tag it?'),
			(i) => !!i,
		))!;
		expect(item.blocking).toBe(false);
		await results('human_ask', 3);
		expect(toolResults('human_ask').at(-1)!.text).toContain(
			'waiting-for-human',
		);
		await stateIs('idle');
		await hostSend('yes, v1', {channel: 'web'});
		expect(k.item(item.id)).toMatchObject({
			state: 'answered',
			answerChannel: 'session',
			answer: 'yes, v1',
		});
	});

	it("human_withdraw refuses another session's item and withdraws its own", async () => {
		const theirs = k.humanAsk({from: OTHER, question: 'Theirs'});
		order(`DO human_withdraw {"itemId":"${theirs.id}"}`);
		await results('human_withdraw', 1);
		expect(toolResults('human_withdraw')[0]).toMatchObject({isError: true});
		expect(toolResults('human_withdraw')[0].text).toContain('not by you');
		expect(k.item(theirs.id)!.state).toBe('open');
		await stateIs('idle');

		order('DO human_ask {"question":"Mine","blocking":false}');
		const mine = (await eventually(
			() => k.inbox().find((i) => i.question === 'Mine'),
			(i) => !!i,
		))!;
		await results('human_ask', 4);
		await stateIs('idle');
		order(`DO human_withdraw {"itemId":"${mine.id}"}`);
		await eventually(
			() => k.item(mine.id)!.state,
			(s) => s === 'withdrawn',
		);
		expect(k.item(mine.id)!.state).toBe('withdrawn');
		await results('human_withdraw', 2);
		expect(toolResults('human_withdraw')[1].text).toContain('withdrawn');
	});

	it("while a blocking human_ask waits, an agent's send is queued as usual and answers nothing", async () => {
		const before = toolResults('human_ask').length;
		order('DO human_ask {"question":"Rebase first?","timeoutSec":60}');
		const p = await eventually(
			() => k.presence(file),
			(p) => p?.state === 'waiting-for-human' && !!p.waitingOn,
		);
		const id = p!.waitingOn!;
		expect(await hostSend('noted while waiting', {source: 'extension'})).toBe(
			'queued',
		);
		expect(k.item(id)!.state).toBe('open');
		// Answered from the web inbox instead: the tool returns it.
		k.answerItem(id, 'yes, rebase', {channel: 'web'});
		await results('human_ask', before + 1);
		expect(toolResults('human_ask').at(-1)!.text).toContain('on web');
		expect(await stateIs('idle')).toBe('idle');
		expect(k.pendingFor(file)).toEqual([]);
	});
});
