import {describe, expect, it} from 'vitest';
import {piCommand, planTerminalSpawn, planWake} from '../src/spawn.js';

const base = {
	folder: '/r/lane',
	spawnId: 'sp_1',
	sessionId: 'sid-1',
	ownerLabel: 'orchestrator:t',
	title: 't/lane',
};

describe('the terminal spawn plan (D19, D28)', () => {
	it('is a detached headless pi -p with the session id up front, bound through SHIPMATES_SPAWN', () => {
		const plan = planTerminalSpawn({...base, env: {}});
		expect(plan).toMatchObject({
			kind: 'headless',
			command: 'pi',
			cwd: '/r/lane',
			env: {SHIPMATES_SPAWN: 'sp_1'},
		});
		expect(plan.args.slice(0, 3)).toEqual(['--session-id', 'sid-1', '-p']);
		expect(plan.args[3]).toContain('not from the human');
		expect(plan.args[3]).toContain('orchestrator:t');
	});

	it('is a zellij pane running an interactive pi with NO prompt when $ZELLIJ is set', () => {
		const plan = planTerminalSpawn({...base, env: {ZELLIJ: '0'}});
		expect(plan.command).toBe('zellij');
		expect(plan.args).toEqual([
			'run',
			'--name',
			't/lane',
			'--cwd',
			'/r/lane',
			'--',
			'env',
			'SHIPMATES_SPAWN=sp_1',
			'pi',
			'--session-id',
			'sid-1',
		]);
		expect(plan.args).not.toContain('-p');
	});

	it('forks with --fork, or starts on a file written up to an entry', () => {
		expect(
			planTerminalSpawn({
				...base,
				env: {},
				fork: {sessionFile: '/s/a.jsonl'},
			}).args.slice(0, 4),
		).toEqual(['--fork', '/s/a.jsonl', '--session-id', 'sid-1']);
		expect(
			planTerminalSpawn({
				...base,
				env: {},
				fork: {sessionFile: '/s/a.jsonl'},
				forkFile: '/s/b.jsonl',
			}).args.slice(0, 2),
		).toEqual(['--session', '/s/b.jsonl']);
	});

	it('wakes with pi --session <path> -p', () => {
		const plan = planWake({
			env: {SHIPMATES_SPAWN_COMMAND: '["pi","--model","x"]'},
			sessionFile: '/s/c.jsonl',
			folder: '/r',
		});
		expect([plan.command, ...plan.args.slice(0, 5)]).toEqual([
			'pi',
			'--model',
			'x',
			'--session',
			'/s/c.jsonl',
			'-p',
		]);
		expect(plan.env).toEqual({});
	});

	it('SHIPMATES_SPAWN_COMMAND must be a JSON array of strings', () => {
		expect(piCommand({})).toEqual(['pi']);
		expect(() => piCommand({SHIPMATES_SPAWN_COMMAND: 'pi --x'})).toThrow(
			/JSON array/,
		);
		expect(() => piCommand({SHIPMATES_SPAWN_COMMAND: '[]'})).toThrow();
	});
});
