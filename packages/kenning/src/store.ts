import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';

export type DB = DatabaseSync;

/**
 * Several pi processes, the CLI and wherever write this file at once. Without a
 * busy timeout SQLite answers SQLITE_BUSY on the first contended write, which an
 * agent would see as a failed send. Every write here is a few rows (well under a
 * millisecond), so 5 s only ever matters when something is badly wrong.
 */
const BUSY_TIMEOUT_MS = 5_000;

/**
 * Forward migrations, applied in order and recorded in meta.schema_version.
 * Unlike memonaut's index, this database is NOT a derived cache: a pending
 * message or an open question exists nowhere else, so it is never dropped and
 * rebuilt (ADR 0001). Append a migration; never edit one that shipped.
 */
const MIGRATIONS: string[] = [
	`
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- One live (or recently live) session. Liveness is (pid, start_time, boot_id):
-- a crashed process stops being live at once, with no heartbeat.
CREATE TABLE presence(
  session_file TEXT PRIMARY KEY,
  session_id TEXT,
  cwd TEXT,
  branch TEXT,
  state TEXT NOT NULL DEFAULT 'idle',
  status TEXT,
  refs TEXT,
  waiting_on TEXT,
  wake INTEGER NOT NULL DEFAULT 1,
  settled_at INTEGER,             -- last time it became idle or waiting-for-human
  pid INTEGER NOT NULL,
  start_time TEXT,
  boot_id TEXT,
  host TEXT,
  registered_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- A role points at whichever session does a job (ADR 0004).
CREATE TABLE role(
  role TEXT PRIMARY KEY,
  session_file TEXT NOT NULL,
  claimed_at INTEGER NOT NULL
);
CREATE INDEX role_session ON role(session_file);

CREATE TABLE message(
  id TEXT PRIMARY KEY,
  from_session TEXT,
  from_label TEXT NOT NULL,
  to_kind TEXT NOT NULL,          -- 'session' | 'role'
  to_target TEXT NOT NULL,        -- a session file or a role
  kind TEXT NOT NULL,             -- 'tell' | 'ask' | 'answer' | 'notice'
  question_id TEXT,
  item_id TEXT,
  text TEXT NOT NULL,
  origin TEXT NOT NULL,           -- 'human' | 'agent' | 'human-relayed'
  relay TEXT,                     -- JSON: the human words carried, and where they come from
  request_id TEXT,
  urgent INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'pending',  -- pending | delivered | superseded | withdrawn
  superseded_by TEXT,
  claim_pid INTEGER,
  claim_start TEXT,
  claim_until INTEGER,
  delivered_to TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE UNIQUE INDEX message_request ON message(from_label, request_id) WHERE request_id IS NOT NULL;
CREATE INDEX message_pending ON message(state, to_kind, to_target);

CREATE TABLE question(
  id TEXT PRIMARY KEY,
  asker_session TEXT,
  asker_label TEXT NOT NULL,
  message_id TEXT NOT NULL,
  to_kind TEXT NOT NULL,
  to_target TEXT NOT NULL,
  text TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open',     -- open | answered | withdrawn
  answer TEXT,
  answer_origin TEXT,
  answer_relay TEXT,
  answered_by TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX question_open ON question(state);

-- An attention item: a question addressed to the human.
CREATE TABLE item(
  id TEXT PRIMARY KEY,
  session_file TEXT NOT NULL,
  question TEXT NOT NULL,
  options TEXT,
  blocking INTEGER NOT NULL DEFAULT 0,
  on_behalf_of TEXT,
  state TEXT NOT NULL DEFAULT 'open',     -- open | answered | withdrawn
  answer TEXT,
  answer_channel TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX item_open ON item(state);

-- Turns a human really typed (ADR 0003): what human-relayed must point at.
CREATE TABLE human_turn(
  id TEXT PRIMARY KEY,
  session_file TEXT NOT NULL,
  text TEXT NOT NULL,
  channel TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX human_turn_session ON human_turn(session_file, at);
`,
];

export function defaultStateDir(): string {
	if (process.env.KENNING_STATE_DIR) return process.env.KENNING_STATE_DIR;
	const base =
		process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
	return path.join(base, 'kenning');
}

export function openDb(stateDir: string): DB {
	fs.mkdirSync(stateDir, {recursive: true});
	const db = new DatabaseSync(path.join(stateDir, 'kenning.db'));
	db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
	// Measured (test/multiprocess.test.ts): when several processes open a NEW
	// database together, the switch to WAL and the first migration can answer
	// SQLITE_BUSY at once, without the busy handler, while another connection is
	// changing the journal mode. It only happens during setup, so setup alone is
	// retried; steady-state writes rely on busy_timeout.
	retryBusy(() => {
		db.exec('PRAGMA journal_mode = WAL');
		db.exec('PRAGMA synchronous = NORMAL');
		migrate(db);
	});
	return db;
}

function retryBusy(fn: () => void): void {
	const deadline = Date.now() + BUSY_TIMEOUT_MS;
	for (let attempt = 0; ; attempt++) {
		try {
			return fn();
		} catch (e) {
			if ((e as {errcode?: number}).errcode !== 5 || Date.now() > deadline)
				throw e;
			Atomics.wait(
				new Int32Array(new SharedArrayBuffer(4)),
				0,
				0,
				5 + Math.random() * 20 * Math.min(attempt + 1, 5),
			);
		}
	}
}

function migrate(db: DB): void {
	write(db, () => {
		const hasMeta = db
			.prepare(
				`SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='meta'`,
			)
			.get();
		let version = 0;
		if (hasMeta) {
			const row = db
				.prepare(`SELECT value FROM meta WHERE key='schema_version'`)
				.get() as {value: string} | undefined;
			version = row ? Number(row.value) : 0;
		}
		if (version > MIGRATIONS.length)
			throw new Error(
				`kenning: database schema ${version} is newer than this kenning (${MIGRATIONS.length}); upgrade kenning`,
			);
		for (let v = version; v < MIGRATIONS.length; v++) db.exec(MIGRATIONS[v]);
		db.prepare(
			`INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', ?)`,
		).run(String(MIGRATIONS.length));
	});
}

/**
 * Run fn in a write transaction. BEGIN IMMEDIATE takes the write lock up front:
 * a deferred transaction that reads then writes can fail with SQLITE_BUSY on the
 * lock upgrade without ever honouring busy_timeout, which is exactly the case
 * several concurrent pi processes would hit.
 */
export function write<T>(db: DB, fn: () => T): T {
	db.exec('BEGIN IMMEDIATE');
	try {
		const out = fn();
		db.exec('COMMIT');
		return out;
	} catch (e) {
		db.exec('ROLLBACK');
		throw e;
	}
}
