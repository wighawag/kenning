import {execFile, spawn as startProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	currentHost,
	defaultStateDir,
	KenningError,
	type Kenning,
	type Ownership,
	type Presence,
	type SpawnVia,
} from 'kenning';

/**
 * The environment variable that tells a terminal child which spawn it is (D28).
 * The child binds itself to the spawn at its own `session_start`, so its first
 * prompt can be queued before `before_agent_start` and no session path has to
 * be guessed. It can only bind a spawn that is not bound yet, to a session
 * nobody owns, and binding only ever yields an `agent` message, so it cannot
 * produce human input. A process that learns an unbound spawn id can bind an
 * unowned session to that spawn's owner, which then owns and may stop it:
 * within ADR 0003's model (it takes running pi with a forged environment).
 */
export const SPAWN_ENV = 'KENNING_SPAWN';

/**
 * How long session_spawn waits for a terminal child to bind itself. Measured:
 * a headless `pi -p` child on the test machine binds 0.20 to 0.25 s after it is
 * started (packages/kenning-pi/test/flows.test.ts logs it); a real pi with
 * user packages loads more, so 30 s leaves room without hanging a turn.
 */
const BIND_TIMEOUT_MS = 30_000;

/** A headless wake is leased this long: a child that never comes up is retried after it. */
export const WAKE_LEASE_MS = 60_000;

/**
 * Once a woken child is up, the next wake waits at least this long after its
 * start, unless it exits having read everything (D29). Without it a child that
 * exits without reading its messages (a crash, a failing model) is restarted
 * in a tight loop: the first version of this code did that in a test, until
 * the test timed out.
 */
export const WAKE_GAP_MS = 5_000;

export interface SpawnParams {
	folder?: string;
	prompt: string;
	role?: string;
	fork?: {sessionFile: string; entryId?: string};
	worktree?: {repo?: string; branch: string};
}

export interface SpawnOutcome {
	ownership: Ownership;
	presence: Presence | null;
	note: string | null;
}

export interface ProcessPlan {
	kind: 'zellij' | 'headless';
	command: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
}

/**
 * The pi a terminal child runs: `KENNING_SPAWN_COMMAND`, a JSON array such as
 * `["pi","--model","sonnet"]`, else `pi`. kenning appends the session and
 * prompt arguments. The tests use it to give children the scripted model.
 */
export function piCommand(env: NodeJS.ProcessEnv): string[] {
	const raw = env.KENNING_SPAWN_COMMAND;
	if (!raw) return ['pi'];
	let cmd: unknown;
	try {
		cmd = JSON.parse(raw);
	} catch {}
	if (
		!Array.isArray(cmd) ||
		!cmd.length ||
		!cmd.every((x) => typeof x === 'string')
	)
		throw new KenningError(
			'KENNING_SPAWN_COMMAND must be a JSON array of strings, e.g. ["pi"]',
			'bad-command',
		);
	return cmd as string[];
}

const kickoff = (ownerLabel: string) =>
	`[kenning] ${ownerLabel} started this session and owns it; its instructions follow as a kenning message (origin agent). This text is not from the human.`;

const wakeKickoff = () =>
	'[kenning] New kenning messages woke this session; they follow. This text is not from the human.';

/**
 * The terminal default (D19, D28): a zellij pane when $ZELLIJ is set, else a
 * detached headless `pi -p`. A pane runs an interactive pi with NO prompt (an
 * interactive prompt would be recorded as the human's words); kenning wakes it
 * with the owner's message once it is up. `pi -p` needs a prompt, so it gets a
 * fixed kickoff line that says it is not the human, and the owner's message
 * joins that run at `before_agent_start`.
 */
export function planTerminalSpawn(input: {
	env: NodeJS.ProcessEnv;
	folder: string;
	spawnId: string;
	sessionId: string;
	ownerLabel: string;
	title: string;
	fork?: {sessionFile: string};
	/** A fork at an entry, already written by forkAt: start from this file. */
	forkFile?: string;
}): ProcessPlan {
	const pi = piCommand(input.env);
	const session = input.forkFile
		? ['--session', input.forkFile]
		: input.fork
			? ['--fork', input.fork.sessionFile, '--session-id', input.sessionId]
			: ['--session-id', input.sessionId];
	if (input.env.ZELLIJ)
		return {
			kind: 'zellij',
			command: 'zellij',
			args: [
				'run',
				'--name',
				input.title,
				'--cwd',
				input.folder,
				'--',
				'env',
				`${SPAWN_ENV}=${input.spawnId}`,
				...pi,
				...session,
			],
			cwd: input.folder,
			env: {},
		};
	return {
		kind: 'headless',
		command: pi[0],
		args: [...pi.slice(1), ...session, '-p', kickoff(input.ownerLabel)],
		cwd: input.folder,
		env: {[SPAWN_ENV]: input.spawnId},
	};
}

/** D29: wake a headless child that is not running: `pi --session <path> -p`. */
export function planWake(input: {
	env: NodeJS.ProcessEnv;
	sessionFile: string;
	folder: string;
}): ProcessPlan {
	const pi = piCommand(input.env);
	return {
		kind: 'headless',
		command: pi[0],
		args: [...pi.slice(1), '--session', input.sessionFile, '-p', wakeKickoff()],
		cwd: input.folder,
		env: {},
	};
}

/**
 * Start a plan in its own process group (detached, unref'd), so the spawner's
 * exit or Ctrl-C never takes it down and it can be killed as a group. A
 * headless child's output goes to `<state dir>/spawn-logs/<id>.log`.
 */
export function startDetached(
	plan: ProcessPlan,
	logName: string,
): Promise<number> {
	const env: NodeJS.ProcessEnv = {...process.env, ...plan.env};
	// The spawner's own role and spawn must not pass to the child.
	delete env.KENNING_ROLE;
	if (!plan.env[SPAWN_ENV]) delete env[SPAWN_ENV];
	let out: number | 'ignore' = 'ignore';
	if (plan.kind === 'headless') {
		const dir = path.join(defaultStateDir(), 'spawn-logs');
		fs.mkdirSync(dir, {recursive: true});
		out = fs.openSync(path.join(dir, `${logName}.log`), 'a');
	}
	return new Promise((resolve, reject) => {
		const child = startProcess(plan.command, plan.args, {
			cwd: plan.cwd,
			env,
			detached: true,
			stdio: ['ignore', out, out],
		});
		if (typeof out === 'number') fs.closeSync(out);
		child.once('error', (e) =>
			reject(
				new KenningError(
					`could not start ${plan.command}: ${e.message}`,
					'spawn-failed',
				),
			),
		);
		child.once('spawn', () => {
			child.unref();
			resolve(child.pid!);
		});
	});
}

function git(cwd: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) =>
		execFile(
			'git',
			['-C', cwd, ...args],
			{timeout: 30_000, encoding: 'utf8'},
			(err, stdout, stderr) =>
				err
					? reject(
							new KenningError(
								`git ${args.join(' ')}: ${(stderr || err.message).trim()}`,
								'git',
							),
						)
					: resolve(stdout),
		),
	);
}

/**
 * D32: a worktree lives at `~/dev/worktrees/<repo>/<branch>` (never beside the
 * repo; `KENNING_WORKTREES_DIR` overrides the root), made with
 * `git worktree add <path> <branch>`. A branch that exists neither locally nor
 * as a remote branch git can track is created from HEAD (`-b`). An existing
 * worktree of that branch is reused.
 */
export async function ensureWorktree(
	repo: string,
	branch: string,
	env: NodeJS.ProcessEnv,
): Promise<string> {
	await git(repo, ['check-ref-format', '--branch', branch]);
	const top = (await git(repo, ['rev-parse', '--show-toplevel'])).trim();
	const root =
		env.KENNING_WORKTREES_DIR || path.join(os.homedir(), 'dev', 'worktrees');
	const dest = path.join(root, path.basename(top), branch);
	if (fs.existsSync(dest)) {
		const head = (
			await git(dest, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')
		).trim();
		if (head !== branch)
			throw new KenningError(
				`${dest} exists but is not a worktree of ${branch}`,
				'worktree',
			);
		return dest;
	}
	fs.mkdirSync(path.dirname(dest), {recursive: true});
	try {
		await git(top, ['worktree', 'add', dest, branch]);
	} catch (e) {
		const local = await git(top, [
			'show-ref',
			'--verify',
			`refs/heads/${branch}`,
		]).then(
			() => true,
			() => false,
		);
		if (local) throw e;
		await git(top, ['worktree', 'add', '-b', branch, dest]);
	}
	return dest;
}

/**
 * D34: a fork at an entry. pi's `--fork` copies a whole transcript, so the
 * branch up to `entryId` is written with pi's own SessionManager (a new header
 * whose parentSession is the source, cwd the new folder) and the child starts
 * on that file.
 */
export async function forkAt(
	source: string,
	entryId: string,
	folder: string,
): Promise<{file: string; sessionId: string}> {
	const {SessionManager} = await import('@earendil-works/pi-coding-agent');
	const dir = SessionManager.create(folder).getSessionDir();
	const sm = SessionManager.open(source, dir, folder);
	if (!sm.getEntry(entryId))
		throw new KenningError(`no entry ${entryId} in ${source}`, 'not-found');
	const file = sm.createBranchedSession(entryId)!;
	return {file, sessionId: sm.getSessionId()};
}

const firstLine = (s: string) => s.trim().split('\n')[0].trim();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(
	read: () => T | null | undefined,
	ms: number,
	signal?: AbortSignal,
): Promise<T | null> {
	const end = Date.now() + ms;
	for (;;) {
		const v = read();
		if (v) return v;
		if (Date.now() > end || signal?.aborted) return null;
		await sleep(50);
	}
}

/**
 * session_spawn (D23, D28): record the spawn, make the worktree, then ask the
 * registered host, else start the terminal default, and return once the new
 * session exists and is bound to its owner. The first prompt is never sent as
 * user input: binding queues it as a `spawn` message from the owner.
 */
export async function spawnSession(
	k: Kenning,
	owner: string,
	params: SpawnParams,
	opts: {cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal},
): Promise<SpawnOutcome> {
	if (!params.prompt?.trim())
		throw new KenningError('a spawn needs a prompt', 'empty');
	let folder = path.resolve(opts.cwd, params.folder ?? '.');
	let worktree: {repo: string; branch: string; path: string} | undefined;
	if (params.worktree) {
		const repo = path.resolve(opts.cwd, params.worktree.repo ?? folder);
		const wt = await ensureWorktree(repo, params.worktree.branch, opts.env);
		worktree = {repo, branch: params.worktree.branch, path: wt};
		folder = wt;
	}
	if (!fs.statSync(folder, {throwIfNoEntry: false})?.isDirectory())
		throw new KenningError(`no folder ${folder}`, 'not-found');
	const fork = params.fork
		? {
				sessionFile: path.resolve(opts.cwd, params.fork.sessionFile),
				entryId: params.fork.entryId,
			}
		: undefined;
	if (fork && !fs.existsSync(fork.sessionFile))
		throw new KenningError(`no transcript ${fork.sessionFile}`, 'not-found');
	const title = (params.role || firstLine(params.prompt)).slice(0, 80);
	const host = currentHost();
	const base = {
		owner,
		folder,
		prompt: params.prompt,
		role: params.role ?? null,
	};

	if (host?.spawn) {
		const sp = k.beginSpawn({
			...base,
			via: 'host',
			detail: {fork, worktree},
		});
		const res = await host.spawn({
			spawnId: sp.id,
			owner,
			folder,
			title,
			role: params.role,
			fork,
			worktree,
		});
		k.bindSpawn(sp.id, res.sessionFile);
		// The host's session may already be up; claim its role for it. It
		// re-claims it from the ownership record on every later start.
		let note: string | null = null;
		if (params.role) {
			const r = k.claimRole(res.sessionFile, params.role);
			if (!r.ok) note = `role ${params.role} is held by ${r.holder}; not taken`;
		}
		const presence = await until(
			() => {
				const p = k.presence(res.sessionFile);
				return p?.live ? p : null;
			},
			5_000,
			opts.signal,
		);
		return {ownership: k.ownership(res.sessionFile)!, presence, note};
	}

	let sessionId: string = randomUUID();
	let forkFile: string | undefined;
	if (fork?.entryId) {
		const f = await forkAt(fork.sessionFile, fork.entryId, folder);
		forkFile = f.file;
		sessionId = f.sessionId;
	}
	const via: SpawnVia = opts.env.ZELLIJ ? 'zellij' : 'headless';
	const sp = k.beginSpawn({
		...base,
		via,
		detail: {sessionId, fork, worktree},
	});
	const plan = planTerminalSpawn({
		env: opts.env,
		folder,
		spawnId: sp.id,
		sessionId,
		ownerLabel: k.labelOf(owner),
		title,
		fork,
		forkFile,
	});
	const started = Date.now();
	const pid = await startDetached(plan, sp.id);
	const bound = await until(
		() => k.spawnRecord(sp.id)?.session,
		BIND_TIMEOUT_MS,
		opts.signal,
	);
	if (!bound)
		return {
			ownership: k.spawnRecord(sp.id)!,
			presence: null,
			note: `started (${plan.kind}, pid ${pid}) but it did not come up within ${BIND_TIMEOUT_MS / 1000} s; it binds itself when its pi starts. Check ${path.join(defaultStateDir(), 'spawn-logs', sp.id + '.log')}.`,
		};
	const presence = k.presence(bound);
	return {
		ownership: k.ownership(bound)!,
		presence: presence?.live ? presence : null,
		note: `${plan.kind}, pid ${pid}, up in ${Date.now() - started} ms`,
	};
}
