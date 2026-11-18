import {spawn} from 'node:child_process';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {openKenning} from '../src/index.js';
import {tempDir} from './helpers.js';

function run(
	args: string[],
): Promise<{code: number | null; out: string; err: string}> {
	return new Promise((resolve) => {
		const child = spawn(
			process.execPath,
			['--import', 'tsx', path.join(__dirname, 'fixtures/writer.ts'), ...args],
			{
				stdio: ['ignore', 'pipe', 'pipe'],
			},
		);
		let out = '';
		let err = '';
		child.stdout.on('data', (d) => (out += d));
		child.stderr.on('data', (d) => (err += d));
		child.on('close', (code) => resolve({code, out, err}));
	});
}

describe('several processes on one database', () => {
	it('lose nothing, duplicate nothing, and never hit SQLITE_BUSY', async () => {
		const dir = tempDir();
		const sessions = ['/p/0.jsonl', '/p/1.jsonl', '/p/2.jsonl', '/p/3.jsonl'];
		const N = 150;
		const results = await Promise.all(
			sessions.map((s, i) =>
				run([dir, s, sessions[(i + 1) % sessions.length], String(N)]),
			),
		);
		for (const r of results) expect(r.err).toBe('');
		for (const r of results) expect(r.code).toBe(0);

		const k = openKenning({stateDir: dir});
		try {
			const all = k.db
				.prepare(`SELECT state, count(*) AS n FROM message GROUP BY state`)
				.all() as {state: string; n: number}[];
			const total = all.reduce((a, r) => a + r.n, 0);
			expect(total).toBe(sessions.length * N);
			const claimedIds = results.flatMap((r) => JSON.parse(r.out) as string[]);
			expect(new Set(claimedIds).size).toBe(claimedIds.length);
			expect(claimedIds.length).toBe(sessions.length * N);
		} finally {
			k.close();
		}
	}, 60_000);
});
