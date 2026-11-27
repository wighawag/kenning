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

// D36: a long-lived print-mode session, built and bound the way wherever's
// server builds one, with and without wherever's server-process marker. Each is
// prompted once at start and never again by its host, so a later message
// reaches it only if the session wakes itself.
let w: World;
let marked: Pi, plain: Pi;
let markedFile: string, plainFile: string;
let k: Shipmates;

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
const ready = async (p: Pi) =>
	(await p.waitFor((e) => e.type === 'ready', {what: `${p.name} ready`}))
		.sessionFile as string;

beforeAll(async () => {
	w = newWorld();
	marked = Pi.startPrintHost(
		w,
		'marked',
		'DO session_register {"role":"w/marked","status":"started"}',
		{wherever: true},
	);
	plain = Pi.startPrintHost(
		w,
		'plain',
		'DO session_register {"role":"w/plain","status":"started"}',
		{wherever: false},
	);
	[markedFile, plainFile] = await Promise.all([ready(marked), ready(plain)]);
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

describe("a print-mode session in wherever's server (D36)", () => {
	it('both sessions are live and idle after their one prompt', () => {
		expect(k.roleHolder('w/marked')).toBe(markedFile);
		expect(k.roleHolder('w/plain')).toBe(plainFile);
		expect(k.presence(markedFile)!.state).toBe('idle');
		expect(k.presence(plainFile)!.state).toBe('idle');
	});

	it('with the marker, an idle session wakes itself for a message and acts on it', async () => {
		k.send({
			from: plainFile,
			to: 'w/marked',
			text: 'DO session_register {"status":"woken by a message"}',
		});
		const status = await eventually(
			() => k.presence(markedFile)?.status,
			(s) => s === 'woken by a message',
		);
		expect(status).toBe('woken by a message');
		expect(k.pendingFor(markedFile)).toEqual([]);
	});

	it("waiting for the human, it holds an agent's message and wakes for the human's inbox answer", async () => {
		k.send({
			from: plainFile,
			to: 'w/marked',
			text: 'DO session_register {"state":"waiting-for-human","status":"waiting on the human"}',
		});
		await eventually(
			() => k.presence(markedFile)?.state,
			(s) => s === 'waiting-for-human',
		);
		expect(k.presence(markedFile)!.state).toBe('waiting-for-human');
		const item = k.humanAsk({from: markedFile, question: 'Which branch?'});

		// Another agent's message waits for the human (D3).
		k.send({
			from: plainFile,
			to: 'w/marked',
			text: 'DO session_register {"status":"agent message ran"}',
		});
		await quiet(1000); // ten polls
		expect(k.presence(markedFile)!.status).toBe('waiting on the human');
		expect(k.pendingFor(markedFile)).toHaveLength(1);

		// The human answers from the inbox (as wherever's web or Telegram does):
		// that is what it waits for, so it wakes, with both messages, in order.
		k.answerItem(item.id, 'DO session_register {"status":"answered: main"}', {
			channel: 'web',
		});
		const status = await eventually(
			() => k.presence(markedFile)?.status,
			(s) => s === 'answered: main',
		);
		expect(status).toBe('answered: main');
		expect(k.pendingFor(markedFile)).toEqual([]);
	});

	// D40: wherever's pool unloads an idle session (session_shutdown, so
	// shipmates unregisters) and loads it again on demand, in the same process.
	const reload = async () => {
		const id = marked.send({type: 'reload'});
		await marked.waitFor((e) => e.type === 'reloaded' && e.id === id, {
			what: 'marked reloaded',
		});
		await eventually(
			() => k.presence(markedFile)?.live,
			(l) => l === true,
		);
	};

	it('a declared waiting-for-human survives an unload and a reload: agent messages stay held', async () => {
		k.send({
			from: plainFile,
			to: 'w/marked',
			text: 'DO session_register {"state":"waiting-for-human","status":"waiting before reload"}',
		});
		await eventually(
			() => k.presence(markedFile)?.state,
			(s) => s === 'waiting-for-human',
		);
		await reload();
		expect(k.presence(markedFile)).toMatchObject({
			state: 'waiting-for-human',
			declaredWaiting: true,
		});

		k.send({
			from: plainFile,
			to: 'w/marked',
			text: 'DO session_register {"status":"agent message ran"}',
		});
		await quiet(1000); // ten polls
		// The status line went with the old presence; the message did not run.
		expect(k.presence(markedFile)!.status).not.toBe('agent message ran');
		expect(k.pendingFor(markedFile)).toHaveLength(1);

		// The human's answer still wakes it (D37), and that run ends the declaration.
		const item = k.humanAsk({from: markedFile, question: 'Go on?'});
		k.answerItem(
			item.id,
			'DO session_register {"status":"answered after reload"}',
			{
				channel: 'web',
			},
		);
		await eventually(
			() => k.presence(markedFile),
			(p) => p?.status === 'answered after reload' && p.state === 'idle',
		);
		expect(k.presence(markedFile)!.declaredWaiting).toBe(false);
		await reload();
		expect(k.presence(markedFile)!.state).toBe('idle');
	});

	it('wake off survives an unload and a reload', async () => {
		// What `/shipmates wake off` writes.
		k.update(markedFile, {wake: false});
		await reload();
		expect(k.presence(markedFile)!.wake).toBe(false);
		k.send({
			from: plainFile,
			to: 'w/marked',
			text: 'DO session_register {"status":"woken with wake on"}',
		});
		await quiet(1000);
		expect(k.presence(markedFile)!.status).not.toBe('woken with wake on');
		expect(k.pendingFor(markedFile)).toHaveLength(1);

		k.update(markedFile, {wake: true});
		const status = await eventually(
			() => k.presence(markedFile)?.status,
			(s) => s === 'woken with wake on',
		);
		expect(status).toBe('woken with wake on');
	});

	const askAndWait = async (question: string) => {
		k.send({
			from: plainFile,
			to: 'w/marked',
			text: `DO human_ask {"question":"${question}","timeoutSec":600}`,
		});
		const p = await eventually(
			() => k.presence(markedFile),
			(p) => p?.state === 'waiting-for-human' && !!p.waitingOn,
		);
		return p!.waitingOn!;
	};

	it('unloaded while a blocking human_ask waits, it comes back declared waiting-for-human', async () => {
		const itemId = await askAndWait('Before the restart?');
		await reload();
		expect(k.item(itemId)!.state).toBe('open');
		expect(k.presence(markedFile)).toMatchObject({
			state: 'waiting-for-human',
			declaredWaiting: true,
		});
		k.send({
			from: plainFile,
			to: 'w/marked',
			text: 'DO session_register {"status":"agent message after restart"}',
		});
		await quiet(1000);
		expect(k.pendingFor(markedFile)).toHaveLength(1);
		k.answerItem(itemId, 'DO session_register {"status":"restart answered"}', {
			channel: 'web',
		});
		await eventually(
			() => k.presence(markedFile),
			(p) => p?.status === 'restart answered' && p.state === 'idle',
		);
		expect(k.presence(markedFile)!.declaredWaiting).toBe(false);
		expect(k.pendingFor(markedFile)).toEqual([]);
	});

	it("stopped by a stop request while a blocking human_ask waits, it is not declared waiting: the owner's next message wakes it", async () => {
		const itemId = await askAndWait('Before the stop?');
		k.requestStop(markedFile, {by: plainFile});
		await eventually(
			() => k.presence(markedFile)?.state,
			(s) => s === 'idle',
		);
		expect(k.presence(markedFile)!.declaredWaiting).toBe(false);
		k.send({
			from: plainFile,
			to: 'w/marked',
			text: 'DO session_register {"status":"after the stop"}',
		});
		await eventually(
			() => k.presence(markedFile)?.status,
			(s) => s === 'after the stop',
		);
		expect(k.presence(markedFile)!.status).toBe('after the stop');
		k.withdrawItem(markedFile, itemId);
	});

	it('without the marker (a print-mode session that is not wherever) it never wakes itself (D29)', async () => {
		k.send({
			from: markedFile,
			to: 'w/plain',
			text: 'DO session_register {"status":"should not run"}',
		});
		// The poller runs every SHIPMATES_POLL_MS (100 ms in the tests), so a
		// session that wakes itself does so within a few hundred ms; 2 s is
		// twenty polls.
		await quiet(2000);
		expect(k.presence(plainFile)!.status).toBe('started');
		expect(k.pendingFor(plainFile).map((m) => m.text)).toEqual([
			'DO session_register {"status":"should not run"}',
		]);
	});
});
