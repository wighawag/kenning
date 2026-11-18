import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach} from 'vitest';
import {
	openKenning,
	type Kenning,
	type ProcessIdentity,
	type ProcessProbe,
} from '../src/index.js';

/** A probe whose processes are alive until the test says they died. */
export class FakeProbe implements ProcessProbe {
	dead = new Set<number>();
	constructor(public pid = 1000) {}
	self(): ProcessIdentity {
		return {
			pid: this.pid,
			startTime: 's' + this.pid,
			bootId: 'boot',
			host: 'test',
		};
	}
	isAlive(p: ProcessIdentity): boolean {
		return !this.dead.has(p.pid);
	}
}

const dirs: string[] = [];
const opened: Kenning[] = [];
afterEach(() => {
	for (const k of opened.splice(0)) k.close();
	for (const d of dirs.splice(0)) fs.rmSync(d, {recursive: true, force: true});
});

export function tempDir(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kenning-test-'));
	dirs.push(d);
	return d;
}

/** Several Kenning handles on ONE state dir, as several processes would have. */
export function world() {
	const stateDir = tempDir();
	let clock = Date.parse('2026-11-17T10:00:00Z');
	const now = () => clock;
	const open = (pid: number) => {
		const probe = new FakeProbe(pid);
		const k = openKenning({stateDir, probe, now});
		opened.push(k);
		return {k, probe};
	};
	return {
		stateDir,
		open,
		advance(ms: number) {
			clock += ms;
		},
	};
}

export const A = '/s/push/a.jsonl';
export const B = '/s/missiv/b.jsonl';
export const C = '/s/triggers/c.jsonl';
