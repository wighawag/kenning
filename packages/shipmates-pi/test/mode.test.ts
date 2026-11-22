import {afterEach, describe, expect, it} from 'vitest';
import {
	WHEREVER_SERVER_KEY,
	inWhereverServer,
	mayBeTerminalHuman,
	mayWakeItself,
} from '../src/mode.js';

const g = globalThis as unknown as Record<symbol, unknown>;

describe('the wherever server marker (D36)', () => {
	afterEach(() => {
		delete g[WHEREVER_SERVER_KEY];
	});

	it('is the contract key, and true only when set to exactly true', () => {
		expect(WHEREVER_SERVER_KEY).toBe(Symbol.for('wherever-dev.server-process'));
		expect(inWhereverServer()).toBe(false);
		g[WHEREVER_SERVER_KEY] = 'yes';
		expect(inWhereverServer()).toBe(false);
		g[WHEREVER_SERVER_KEY] = true;
		expect(inWhereverServer()).toBe(true);
	});
});

describe('mayWakeItself (D29, D36)', () => {
	it('a real pi -p (print or json, no marker) never wakes itself', () => {
		expect(mayWakeItself({mode: 'print', inWhereverServer: false})).toBe(false);
		expect(mayWakeItself({mode: 'json', inWhereverServer: false})).toBe(false);
	});

	it("a print or json session inside wherever's server wakes itself", () => {
		expect(mayWakeItself({mode: 'print', inWhereverServer: true})).toBe(true);
		expect(mayWakeItself({mode: 'json', inWhereverServer: true})).toBe(true);
	});

	it('the TUI and rpc modes wake themselves either way', () => {
		for (const inWhereverServer of [false, true]) {
			expect(mayWakeItself({mode: 'tui', inWhereverServer})).toBe(true);
			expect(mayWakeItself({mode: 'rpc', inWhereverServer})).toBe(true);
		}
	});
});

describe('mayBeTerminalHuman (ADR 0003, D27, D36)', () => {
	const base = {stdinIsTTY: true, inAgentSession: false};

	it('the TUI is the human', () => {
		expect(
			mayBeTerminalHuman({...base, mode: 'tui', inWhereverServer: false}),
		).toBe(true);
	});

	it('pi -p at a terminal outside an agent session is the human, inside one it is not', () => {
		expect(
			mayBeTerminalHuman({...base, mode: 'print', inWhereverServer: false}),
		).toBe(true);
		expect(
			mayBeTerminalHuman({
				...base,
				mode: 'print',
				inWhereverServer: false,
				inAgentSession: true,
			}),
		).toBe(false);
		expect(
			mayBeTerminalHuman({
				...base,
				mode: 'print',
				inWhereverServer: false,
				stdinIsTTY: false,
			}),
		).toBe(false);
	});

	it("inside wherever's server it is never the human, even with a TTY on stdin", () => {
		expect(
			mayBeTerminalHuman({...base, mode: 'print', inWhereverServer: true}),
		).toBe(false);
		expect(
			mayBeTerminalHuman({...base, mode: 'json', inWhereverServer: true}),
		).toBe(false);
	});
});
