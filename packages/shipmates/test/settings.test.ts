import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {describe, expect, it} from 'vitest';
import {openShipmates} from '../src/index.js';
import {MIGRATIONS} from '../src/store.js';
import {A, B, tempDir, world} from './helpers.js';

const DAY = 86_400_000;

// D40: what a session chose for itself (`/shipmates wake off`, a declared
// `waiting-for-human`) belongs to its transcript file, not to the process that
// happened to register it, so it survives an unload and a resume.
describe('session settings outlive presence (D40)', () => {
	it('wake off survives unregister and register, in the same process (a host pool) or another (a resume)', () => {
		const w = world();
		const one = w.open(1);
		one.k.register({sessionFile: A, cwd: '/r'});
		one.k.update(A, {wake: false});
		one.k.unregister(A);
		expect(one.k.presence(A)).toBeNull();
		one.k.register({sessionFile: A, cwd: '/r'});
		expect(one.k.presence(A)!.wake).toBe(false);

		one.k.unregister(A);
		const two = w.open(2);
		two.k.register({sessionFile: A, cwd: '/r'});
		expect(two.k.presence(A)).toMatchObject({wake: false, live: true});
		two.k.update(A, {wake: true});
		two.k.unregister(A);
		two.k.register({sessionFile: A, cwd: '/r'});
		expect(two.k.presence(A)!.wake).toBe(true);
	});

	it('a declared waiting-for-human survives too, and registering restores the state', () => {
		const w = world();
		const one = w.open(1);
		one.k.register({sessionFile: A, cwd: '/r'});
		one.k.update(A, {state: 'waiting-for-human', declaredWaiting: true});
		one.k.unregister(A);
		one.k.register({sessionFile: A, cwd: '/r'});
		expect(one.k.presence(A)).toMatchObject({
			state: 'waiting-for-human',
			declaredWaiting: true,
		});

		// A new run clears the declaration; the next load is idle.
		one.k.update(A, {state: 'running', declaredWaiting: false});
		one.k.unregister(A);
		const two = w.open(2);
		two.k.register({sessionFile: A, cwd: '/r'});
		expect(two.k.presence(A)).toMatchObject({
			state: 'idle',
			declaredWaiting: false,
		});
	});

	it('a crashed process still reads as not live, and its settings wait for the next start', () => {
		const w = world();
		const one = w.open(1);
		const two = w.open(2);
		two.k.register({sessionFile: A, cwd: '/r'});
		two.k.update(A, {
			wake: false,
			state: 'waiting-for-human',
			declaredWaiting: true,
		});
		one.probe.dead.add(2);
		expect(one.k.isLive(A)).toBe(false);
		expect(one.k.list()).toEqual([]);
		// Dead presence is pruned after a day (D11); the settings are not.
		w.advance(DAY + 1);
		one.k.prune();
		expect(one.k.presence(A)).toBeNull();
		const three = w.open(3);
		three.k.register({sessionFile: A, cwd: '/r'});
		expect(three.k.presence(A)).toMatchObject({
			live: true,
			wake: false,
			state: 'waiting-for-human',
		});
	});

	it('another file (a fork, a new session) starts from the defaults', () => {
		const w = world();
		const {k} = w.open(1);
		k.register({sessionFile: A, cwd: '/r'});
		k.update(A, {
			wake: false,
			state: 'waiting-for-human',
			declaredWaiting: true,
		});
		k.register({sessionFile: B, cwd: '/r'});
		expect(k.presence(B)).toMatchObject({
			wake: true,
			declaredWaiting: false,
			state: 'idle',
		});
	});

	it('settings go once the transcript is gone, nobody runs it, and they are 30 days old', () => {
		const w = world();
		const {k} = w.open(1);
		const dir = tempDir();
		const exists = path.join(dir, 'kept.jsonl');
		fs.writeFileSync(exists, '');
		for (const f of [A, exists]) {
			k.register({sessionFile: f, cwd: '/r'});
			k.update(f, {wake: false});
			k.unregister(f);
		}
		w.advance(31 * DAY);
		k.prune();
		k.register({sessionFile: A, cwd: '/r'});
		k.register({sessionFile: exists, cwd: '/r'});
		expect(k.presence(A)!.wake).toBe(true);
		expect(k.presence(exists)!.wake).toBe(false);
	});

	it('a host reads the settings of sessions with no live presence: settings() and setting(file)', () => {
		const w = world();
		const {k} = w.open(1);
		k.register({sessionFile: A, cwd: '/r'});
		k.register({sessionFile: B, cwd: '/r'});
		expect(k.settings()).toEqual([]);
		expect(k.setting(A)).toEqual({
			sessionFile: A,
			wake: true,
			declaredWaiting: false,
			updatedAt: null,
		});
		k.update(A, {declaredWaiting: true});
		w.advance(1000);
		k.update(B, {wake: false});
		k.unregister(A);
		k.unregister(B);
		expect(k.list()).toEqual([]);
		const t = Date.parse('2026-11-17T10:00:00Z');
		expect(k.settings()).toEqual([
			{
				sessionFile: B,
				wake: false,
				declaredWaiting: false,
				updatedAt: t + 1000,
			},
			{sessionFile: A, wake: true, declaredWaiting: true, updatedAt: t},
		]);
		expect(k.setting(A)).toMatchObject({declaredWaiting: true});
		// Back to the defaults: the row goes.
		k.update(B, {wake: true});
		expect(k.settings().map((s) => s.sessionFile)).toEqual([A]);
	});

	it('the migration carries over a wake off set in a schema-2 database', () => {
		const dir = tempDir();
		const db = new DatabaseSync(path.join(dir, 'shipmates.db'));
		db.exec('PRAGMA journal_mode = WAL');
		db.exec(MIGRATIONS[0]);
		db.exec(MIGRATIONS[1]);
		db.prepare(
			`INSERT INTO meta(key, value) VALUES('schema_version', '2')`,
		).run();
		db.prepare(
			`INSERT INTO presence(session_file, wake, pid, registered_at, updated_at) VALUES(?, 0, 1, 1, 1)`,
		).run(A);
		db.close();
		const k = openShipmates({stateDir: dir});
		try {
			// The old row is a dead process's; the setting must not depend on it.
			k.db.prepare(`DELETE FROM presence`).run();
			k.register({sessionFile: A, cwd: '/r'});
			expect(k.presence(A)!.wake).toBe(false);
		} finally {
			k.close();
		}
	});
});
