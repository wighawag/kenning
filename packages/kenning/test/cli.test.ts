import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {openKenning, runCli} from '../src/index.js';
import {A, B, tempDir} from './helpers.js';

function cli(
	stateDir: string,
	argv: string[],
	opts: {tty?: boolean; env?: Record<string, string>} = {},
) {
	let out = '';
	let err = '';
	const code = runCli(argv, {
		env: {KENNING_STATE_DIR: stateDir, ...opts.env},
		isTTY: opts.tty ?? true,
		stdout: (s) => (out += s),
		stderr: (s) => (err += s),
	});
	return {code, out, err};
}

function seeded() {
	const dir = tempDir();
	const k = openKenning({stateDir: dir});
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

describe('kenning CLI', () => {
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
				env: {...process.env, KENNING_STATE_DIR: dir},
				encoding: 'utf8',
			},
		);
		expect(out).toContain('No live sessions');
	});
});
