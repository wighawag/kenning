import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {describe, expect, it} from 'vitest';
import {ARCHIVE_UNDO_MS, KenningError, openKenning} from '../src/index.js';
import {MIGRATIONS} from '../src/store.js';
import {A, B, C, tempDir, world} from './helpers.js';

const DAY = 86_400_000;
const D = '/s/grandchild/d.jsonl';

describe('ownership', () => {
	it('a spawn is recorded before its session exists, and binding delivers the first prompt from the owner, origin agent', () => {
		const w = world();
		const {k} = w.open(1);
		k.register({sessionFile: A, cwd: '/r'});
		k.claimRole(A, 'orchestrator:plan');
		const sp = k.beginSpawn({
			owner: A,
			folder: '/r/lane',
			prompt: 'build the push lane',
			role: 'plan/push',
			via: 'headless',
			detail: {sessionId: 'abc'},
		});
		expect(sp).toMatchObject({session: null, owner: A, via: 'headless'});
		expect(k.ownedBy(A)).toEqual([]); // not up yet

		const bound = k.bindSpawn(sp.id, B);
		expect(bound).toMatchObject({
			session: B,
			owner: A,
			folder: '/r/lane',
			role: 'plan/push',
			detail: {sessionId: 'abc'},
		});
		expect(k.ownerOf(B)).toBe(A);
		const [first] = k.pendingFor(B);
		expect(first).toMatchObject({
			kind: 'spawn',
			from: A,
			fromLabel: 'orchestrator:plan',
			origin: 'agent',
			text: 'build the push lane',
		});
		// Binding again is a no-op, and never queues the prompt twice.
		k.bindSpawn(sp.id, B);
		expect(k.pendingFor(B)).toHaveLength(1);
	});

	it('ownership never changes: a bound spawn, or an owned session, cannot be re-owned', () => {
		const w = world();
		const {k} = w.open(1);
		const sp = k.beginSpawn({owner: A, folder: '/r', via: 'host'});
		k.bindSpawn(sp.id, B);
		expect(() => k.bindSpawn(sp.id, C)).toThrow(/already/);
		expect(() =>
			k.recordOwnership({session: B, owner: C, folder: '/r', via: 'recorded'}),
		).toThrow(/already owned by/);
		expect(k.ownerOf(B)).toBe(A);
		// The refused record leaves nothing behind.
		expect(k.ownedBy(C)).toEqual([]);
	});

	it('refuses a cycle', () => {
		const w = world();
		const {k} = w.open(1);
		k.recordOwnership({session: B, owner: A, folder: '/r', via: 'recorded'});
		expect(() =>
			k.recordOwnership({session: A, owner: B, folder: '/r', via: 'recorded'}),
		).toThrow(KenningError);
		expect(() =>
			k.recordOwnership({session: C, owner: C, folder: '/r', via: 'recorded'}),
		).toThrow(/cycle/);
	});

	it('ownedBy includes sessions that are not live; owns is transitive', () => {
		const w = world();
		const one = w.open(1);
		const two = w.open(2);
		const {k} = one;
		k.recordOwnership({session: B, owner: A, folder: '/r', via: 'recorded'});
		k.recordOwnership({session: C, owner: A, folder: '/r', via: 'recorded'});
		k.recordOwnership({session: D, owner: C, folder: '/r', via: 'recorded'});
		two.k.register({sessionFile: B, cwd: '/r'});
		one.probe.dead.add(2);
		expect(k.isLive(B)).toBe(false);
		expect(k.ownedBy(A).map((o) => o.session)).toEqual([B, C]);
		expect(k.ownedBy(A, {transitive: true}).map((o) => o.session)).toEqual([
			B,
			C,
			D,
		]);
		expect(k.owns(A, D)).toBe(true);
		expect(k.owns(C, D)).toBe(true);
		expect(k.owns(B, D)).toBe(false);
		expect(k.owns(D, A)).toBe(false);
		expect(k.owns(A, A)).toBe(false);
	});

	it('archive cascades to the owned set as one batch, undoable within 7 days', () => {
		const w = world();
		const {k} = w.open(1);
		k.recordOwnership({session: B, owner: A, folder: '/r', via: 'recorded'});
		k.recordOwnership({session: D, owner: B, folder: '/r', via: 'recorded'});
		k.archive(D, {kind: 'archived', by: 'web'}); // archived on its own first
		const r = k.archive(A, {kind: 'deleted', by: 'web'});
		expect(r.sessions).toEqual([A, B]); // D keeps its own batch
		expect(r.undoUntil - r.at).toBe(ARCHIVE_UNDO_MS);
		expect(k.archiveMark(B)).toMatchObject({kind: 'deleted', batch: r.batch});
		expect(k.ownership(B)!.archived).toMatchObject({kind: 'deleted'});
		expect(k.expiredArchives()).toEqual([]);

		expect(k.undoArchive(r.batch).sort()).toEqual([A, B].sort());
		expect(k.archiveMark(A)).toBeNull();
		expect(k.archiveMark(D)).toMatchObject({kind: 'archived'});

		const again = k.archive(A, {kind: 'deleted', by: 'web'});
		w.advance(ARCHIVE_UNDO_MS + 1);
		expect(k.expiredArchives().map((m) => m.session)).toEqual(
			expect.arrayContaining([A, B]),
		);
		expect(() => k.undoArchive(again.batch)).toThrow(/undo window/);
	});

	it('a wake lease goes to one caller; once the child is up, the next wake waits out a short gap', () => {
		const w = world();
		const one = w.open(1);
		const two = w.open(2);
		one.k.recordOwnership({
			session: B,
			owner: A,
			folder: '/r',
			via: 'headless',
		});
		expect(one.k.leaseWake(B, 60_000)).toEqual({ok: true});
		const t = one.k.now();
		expect(two.k.leaseWake(B, 60_000)).toEqual({ok: false, until: t + 60_000});
		two.k.wakeDone(B, 5_000); // the child came up
		expect(two.k.leaseWake(B, 60_000)).toEqual({ok: false, until: t + 5_000});
		w.advance(5_001);
		expect(two.k.leaseWake(B, 60_000)).toEqual({ok: true});
		w.advance(60_001);
		expect(one.k.leaseWake(B, 60_000)).toEqual({ok: true});
		expect(one.k.leaseWake(C, 60_000)).toEqual({ok: false, until: null}); // not owned
		// A refused lease writes nothing: no change for the pollers to react to.
		one.k.leaseWake(B, 60_000);
		const token = one.k.changeToken();
		expect(one.k.leaseWake(B, 60_000).ok).toBe(false);
		expect(one.k.changeToken()).toBe(token);
	});
});

describe('wake candidates (D29)', () => {
	it('are headless children with mail newer than their last stop, by session or role, not archived', () => {
		const w = world();
		const {k} = w.open(1);
		k.recordOwnership({session: B, owner: A, folder: '/r', via: 'headless'});
		k.recordOwnership({session: C, owner: A, folder: '/r', via: 'host'});
		k.recordOwnership({session: D, owner: A, folder: '/r', via: 'headless'});
		k.claimRole(D, 'plan/d');
		expect(k.wakeCandidates(A)).toEqual([]);
		k.send({from: A, to: B, text: 'for b'});
		k.send({from: A, to: C, text: 'for c, a host child'});
		k.send({from: A, to: 'plan/d', text: 'for d, by role'});
		expect(k.wakeCandidates(A).map((o) => o.session)).toEqual([B, D]);
		w.advance(1);
		k.requestStop(B, {by: A}); // pending mail older than the stop waits
		expect(k.wakeCandidates(A).map((o) => o.session)).toEqual([D]);
		w.advance(1);
		k.send({from: A, to: B, text: 'after the stop'});
		k.archive(D, {kind: 'archived', by: 'web'});
		expect(k.wakeCandidates(A).map((o) => o.session)).toEqual([B]);
		expect(k.wakeCandidates(B)).toEqual([]);
	});
});

describe('stop requests', () => {
	it('are recorded for the target, acted on once, and remembered for the waker', () => {
		const w = world();
		const {k} = w.open(1);
		k.register({sessionFile: B, cwd: '/r'});
		expect(k.lastStopAt(B)).toBeNull();
		const req = k.requestStop(B, {by: A});
		expect(req).toMatchObject({session: B, by: A, handledAt: null});
		expect(k.openStops(B).map((s) => s.id)).toEqual([req.id]);
		k.settleStop(req.id, 'stopped');
		k.settleStop(req.id, 'not-running'); // the first outcome stands
		expect(k.stopRequest(req.id)).toMatchObject({outcome: 'stopped'});
		expect(k.openStops(B)).toEqual([]);
		expect(k.lastStopAt(B)).toBe(req.at);
	});
});

describe('retention of ownership (D25)', () => {
	it('never prunes the ownership of a session whose transcript exists; prunes a gone one after 30 days, and a spawn that never came up after a day', () => {
		const w = world();
		const {k} = w.open(1);
		const dir = tempDir();
		const exists = path.join(dir, 'exists.jsonl');
		fs.writeFileSync(exists, '{}\n');
		const gone = path.join(dir, 'gone.jsonl');
		k.recordOwnership({session: exists, owner: A, folder: '/r', via: 'host'});
		k.recordOwnership({session: gone, owner: A, folder: '/r', via: 'host'});
		const never = k.beginSpawn({owner: A, folder: '/r', via: 'headless'});
		k.archive(gone, {kind: 'deleted', by: 'web'});

		w.advance(DAY + 1);
		k.prune();
		expect(k.spawnRecord(never.id)).toBeNull();
		expect(k.ownerOf(gone)).toBe(A); // a fresh session may have no file yet

		w.advance(30 * DAY);
		k.prune();
		expect(k.ownerOf(exists)).toBe(A);
		expect(k.ownerOf(gone)).toBeNull();
		expect(k.archiveMark(gone)).toBeNull();

		w.advance(365 * DAY);
		k.prune();
		expect(k.ownerOf(exists)).toBe(A);
	});
});

describe('migration from a milestone-1 database', () => {
	it('adds ownership without touching what was there', () => {
		const dir = tempDir();
		const db = new DatabaseSync(path.join(dir, 'kenning.db'));
		db.exec('PRAGMA journal_mode = WAL');
		db.exec(MIGRATIONS[0]);
		db.prepare(
			`INSERT INTO meta(key, value) VALUES('schema_version', '1')`,
		).run();
		db.prepare(
			`INSERT INTO message(id, from_session, from_label, to_kind, to_target, kind, text, origin, created_at)
			 VALUES('m_old', ?, 'a', 'session', ?, 'tell', 'from milestone 1', 'agent', 1)`,
		).run(A, B);
		db.close();

		const k = openKenning({stateDir: dir});
		try {
			const v = k.db
				.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`)
				.get() as {value: string};
			expect(Number(v.value)).toBe(MIGRATIONS.length);
			expect(k.message('m_old')).toMatchObject({
				state: 'pending',
				text: 'from milestone 1',
			});
			k.recordOwnership({session: B, owner: A, folder: '/r', via: 'recorded'});
			expect(k.ownerOf(B)).toBe(A);
		} finally {
			k.close();
		}
		// Opening again applies nothing twice.
		openKenning({stateDir: dir}).close();
	});
});
