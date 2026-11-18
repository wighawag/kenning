import {openKenning, type Kenning} from 'kenning';
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
let k: Kenning;

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
	k = openKenning({stateDir: w.stateDir});
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

	it('without the marker (a print-mode session that is not wherever) it never wakes itself (D29)', async () => {
		k.send({
			from: markedFile,
			to: 'w/plain',
			text: 'DO session_register {"status":"should not run"}',
		});
		// The poller runs every KENNING_POLL_MS (100 ms in the tests), so a
		// session that wakes itself does so within a few hundred ms; 2 s is
		// twenty polls.
		await quiet(2000);
		expect(k.presence(plainFile)!.status).toBe('started');
		expect(k.pendingFor(plainFile).map((m) => m.text)).toEqual([
			'DO session_register {"status":"should not run"}',
		]);
	});
});
