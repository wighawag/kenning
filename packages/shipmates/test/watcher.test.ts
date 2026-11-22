import {describe, expect, it} from 'vitest';
import {openShipmates, watchChanges} from '../src/index.js';
import {A, B, tempDir} from './helpers.js';

describe('watchChanges', () => {
	it('calls back when another connection writes, and stops cleanly', async () => {
		const dir = tempDir();
		const mine = openShipmates({stateDir: dir});
		const theirs = openShipmates({stateDir: dir});
		let calls = 0;
		const w = watchChanges(mine, () => calls++, {intervalMs: 10});
		await new Promise((r) => setTimeout(r, 40));
		const before = calls;
		theirs.register({sessionFile: A, cwd: '/r'});
		await new Promise((r) => setTimeout(r, 60));
		expect(calls).toBe(before + 1);
		mine.register({sessionFile: B, cwd: '/r'}); // its own writes count too
		await new Promise((r) => setTimeout(r, 60));
		expect(calls).toBe(before + 2);
		w.stop();
		theirs.update(A, {status: 'x'});
		await new Promise((r) => setTimeout(r, 60));
		expect(calls).toBe(before + 2);
		mine.close();
		theirs.close();
	});
});
