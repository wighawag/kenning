import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {openShipmates, runCli} from '../src/index.js';
import {A, B, tempDir} from './helpers.js';

function cli(
	stateDir: string,
	argv: string[],
	opts: {tty?: boolean; env?: Record<string, string>} = {},
) {
	let out = '';
	let err = '';
	const code = runCli(argv, {
		env: {SHIPMATES_STATE_DIR: stateDir, ...opts.env},
		isTTY: opts.tty ?? true,
		stdout: (s) => (out += s),
		stderr: (s) => (err += s),
	});
	return {code, out, err};
}

function seeded() {
	const dir = tempDir();
	const k = openShipmates({stateDir: dir});
	k.register({sessionFile: A, sessionId: 'aaa', cwd: '/r/push'});
	k.register({sessionFile: B, sessionId: 'bbb', cwd: '/r/missiv'});
	k.claimRole(A, 'template-tree/push');
	const item = k.humanAsk({
		from: A,
		question: 'Publish 0.2.0?',
		options: ['done', 'not now'],
	});
	const q = k.send({from: B, to: A, kind: 'ask', text: 'MIT?'}).question!;
	return {dir, k, item, q};
}

describe('shipmates CLI', () => {
	it('lists live sessions and the inbox', () => {
		const {dir, k} = seeded();
		expect(cli(dir, ['list']).out).toContain('template-tree/push');
		expect(cli(dir, ['inbox']).out).toContain('Publish 0.2.0?');
		expect(JSON.parse(cli(dir, ['inbox', '--json']).out)).toHaveLength(1);
		k.close();
	});

	it('a human at a terminal answers an inbox item, as origin human', () => {
		const {dir, k, item} = seeded();
		const r = cli(dir, ['answer', item.id, 'done']);
		expect(r.code).toBe(0);
		expect(k.item(item.id)).toMatchObject({
			state: 'answered',
			answer: 'done',
			answerChannel: 'cli',
		});
		expect(k.pendingFor(A).find((m) => m.itemId === item.id)).toMatchObject({
			origin: 'human',
			text: 'done',
			kind: 'answer',
		});
		k.close();
	});

	it('refuses to answer as the human without a terminal, or from inside an agent session', () => {
		const {dir, k, item} = seeded();
		expect(cli(dir, ['answer', item.id, 'done'], {tty: false})).toMatchObject({
			code: 1,
			err: expect.stringContaining('terminal'),
		});
		expect(
			cli(dir, ['answer', item.id, 'done'], {env: {PI_SESSION_FILE: A}}),
		).toMatchObject({code: 1, err: expect.stringContaining('agent session')});
		expect(k.item(item.id)!.state).toBe('open');
		k.close();
	});

	it("tell from a human is origin human; from an agent's bash it is that session, origin agent", () => {
		const {dir, k} = seeded();
		cli(dir, ['tell', 'template-tree/push', 'from', 'the', 'human']);
		cli(dir, ['tell', 'template-tree/push', 'from bash'], {
			tty: false,
			env: {PI_SESSION_FILE: B},
		});
		expect(
			k
				.pendingFor(A)
				.filter((m) => m.kind === 'tell')
				.map((m) => [m.text, m.origin, m.from]),
		).toEqual([
			['from the human', 'human', null],
			['from bash', 'agent', B],
		]);
		k.close();
	});

	it("a human can answer a session's question too", () => {
		const {dir, k, q} = seeded();
		expect(cli(dir, ['answer', q.id, 'yes', 'MIT']).code).toBe(0);
		expect(k.question(q.id)).toMatchObject({
			state: 'answered',
			answer: 'yes MIT',
			answerOrigin: 'human',
		});
		k.close();
	});

	it('owned lists what a session spawned, live or not, and its own owner', () => {
		const {dir, k} = seeded();
		k.recordOwnership({
			session: B,
			owner: A,
			folder: '/r/missiv',
			role: 'plan/messaging',
			via: 'headless',
		});
		k.recordOwnership({
			session: '/s/gone/c.jsonl',
			owner: B,
			folder: '/r/c',
			via: 'zellij',
		});
		const r = cli(dir, ['owned', 'template-tree/push']);
		expect(r.code).toBe(0);
		expect(r.out).toContain(B);
		expect(r.out).toContain('plan/messaging');
		expect(r.out).toContain('/s/gone/c.jsonl');
		expect(r.out).toContain(`owned by ${B}`);
		expect(r.out).toContain('not live');
		expect(cli(dir, ['owned', 'bbb']).out).toContain(`owner: ${A}`);
		const json = JSON.parse(cli(dir, ['owned', A, '--json']).out);
		expect(json.owned.map((o: {session: string}) => o.session)).toEqual([
			B,
			'/s/gone/c.jsonl',
		]);
		k.close();
	});

	it('stop is the human at a terminal only, for any live session, and asks for the current turn only', () => {
		const {dir, k} = seeded();
		expect(cli(dir, ['stop', 'bbb'], {tty: false})).toMatchObject({
			code: 1,
			err: expect.stringContaining('terminal'),
		});
		expect(
			cli(dir, ['stop', 'bbb'], {env: {PI_SESSION_FILE: A}}),
		).toMatchObject({code: 1, err: expect.stringContaining('agent session')});
		expect(k.openStops(B)).toEqual([]);

		const r = cli(dir, ['stop', 'bbb']);
		expect(r.code).toBe(0);
		expect(r.out).toContain('Sessions it owns are not stopped');
		expect(k.openStops(B)).toMatchObject([{by: null, byLabel: 'human'}]);
		expect(cli(dir, ['stop', '/s/nobody/x.jsonl']).out).toContain(
			'not running',
		);
		k.close();
	});

	it('reports errors plainly', () => {
		const {dir, k} = seeded();
		expect(cli(dir, ['tell', 'nobody', 'x'])).toMatchObject({
			code: 1,
			err: expect.stringContaining('no session or role'),
		});
		expect(cli(dir, ['frobnicate']).code).toBe(2);
		k.close();
	});

	it('the bin runs', () => {
		const dir = tempDir();
		const out = execFileSync(
			process.execPath,
			['--import', 'tsx', path.join(__dirname, '../src/cli.ts'), 'list'],
			{
				env: {...process.env, SHIPMATES_STATE_DIR: dir},
				encoding: 'utf8',
			},
		);
		expect(out).toContain('No live sessions');
	});
});
