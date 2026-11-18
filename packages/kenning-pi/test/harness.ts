import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const KENNING_PI = path.resolve(here, '../src/index.ts');
const BRAIN = path.resolve(here, 'fixtures/brain.ts');
const HOST = path.resolve(here, 'fixtures/host.ts');
export const FAKE_HOST = path.resolve(here, 'fixtures/fake-host.ts');
const PRINT_HOST = path.resolve(here, 'fixtures/print-host.ts');

/** pi on the scripted model with only kenning and the fixtures loaded; also what spawned children run. */
function piCommand(world: World): string[] {
	return [
		'pi',
		'--no-extensions',
		'--no-skills',
		'--no-prompt-templates',
		'--no-context-files',
		'-e',
		KENNING_PI,
		'-e',
		BRAIN,
		'-e',
		HOST,
		'--provider',
		'faux',
		'--model',
		'brain',
		'--session-dir',
		world.sessionDir,
	];
}

/** The environment every test pi, and everything it starts, runs with. */
export function testEnv(world: World): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		KENNING_STATE_DIR: world.stateDir,
		KENNING_POLL_MS: '100',
		KENNING_SPAWN_COMMAND: JSON.stringify(piCommand(world)),
		KENNING_WORKTREES_DIR: path.join(world.root, 'worktrees'),
		KENNING_TEST_SESSION_DIR: world.sessionDir,
		KENNING_TEST_HOST_LOG: path.join(world.root, 'host.jsonl'),
		PI_CODING_AGENT_DIR: world.agentDir,
		PI_OFFLINE: '1',
		PI_SKIP_VERSION_CHECK: '1',
	};
	delete env.PI_SUBAGENT_CHILD;
	delete env.KENNING_ROLE;
	delete env.KENNING_SPAWN;
	// A developer running the suite inside zellij must not get panes.
	delete env.ZELLIJ;
	return env;
}

export type Event = {type: string; [k: string]: any};

/**
 * A real `pi --mode rpc` process on the faux brain. It leads its own process
 * group (detached), so stop() takes down everything it started, and every
 * process started by a test is tracked so the suite can prove none survives.
 */
export class Pi {
	readonly events: Event[] = [];
	private buf = '';
	private waiters: {
		pred: (e: Event) => boolean;
		from: number;
		resolve: (e: Event) => void;
	}[] = [];
	private nextId = 1;
	exited: Promise<number | null>;

	private constructor(
		readonly name: string,
		readonly proc: ChildProcessWithoutNullStreams,
	) {
		proc.stdout.on('data', (d: Buffer) => this.onData(d));
		proc.stderr.on('data', (d: Buffer) => {
			if (process.env.KENNING_TEST_DEBUG)
				process.stderr.write(`[${name}] ${d}`);
		});
		this.exited = new Promise((r) => proc.on('exit', (code) => r(code)));
	}

	static start(world: World, name: string, extra: string[] = []): Pi {
		const cwd = path.join(world.root, name);
		fs.mkdirSync(cwd, {recursive: true});
		const [cmd, ...args] = piCommand(world);
		const proc = spawn(cmd, ['--mode', 'rpc', ...args, ...extra], {
			cwd,
			env: testEnv(world),
			detached: true,
			stdio: ['pipe', 'pipe', 'pipe'],
		}) as ChildProcessWithoutNullStreams;
		const pi = new Pi(name, proc);
		world.procs.push(pi);
		return pi;
	}

	/**
	 * A long-lived print-mode session built with the SDK, as wherever's server
	 * builds one (fixtures/print-host.ts): prompted once with `prompt`, never
	 * again. `wherever` sets wherever's server-process marker in it (D36).
	 */
	static startPrintHost(
		world: World,
		name: string,
		prompt: string,
		opts: {wherever: boolean},
	): Pi {
		const cwd = path.join(world.root, name);
		fs.mkdirSync(cwd, {recursive: true});
		// Node runs the .ts fixture by stripping types: on by default from 22.18
		// and 23.6, behind a flag on the older Nodes `engines` allows (>=22.5).
		const strip = (process as {features?: {typescript?: unknown}}).features
			?.typescript
			? []
			: ['--experimental-strip-types'];
		const proc = spawn(process.execPath, [...strip, PRINT_HOST, prompt], {
			cwd,
			env: {
				...testEnv(world),
				PRINT_HOST_WHEREVER: opts.wherever ? '1' : '0',
			},
			detached: true,
			stdio: ['pipe', 'pipe', 'pipe'],
		}) as ChildProcessWithoutNullStreams;
		const pi = new Pi(name, proc);
		world.procs.push(pi);
		return pi;
	}

	private onData(d: Buffer) {
		this.buf += d.toString('utf8');
		let i: number;
		while ((i = this.buf.indexOf('\n')) >= 0) {
			const line = this.buf.slice(0, i).replace(/\r$/, '');
			this.buf = this.buf.slice(i + 1);
			if (!line.trim()) continue;
			let e: Event;
			try {
				e = JSON.parse(line);
			} catch {
				continue;
			}
			this.events.push(e);
			const idx = this.events.length - 1;
			for (const w of [...this.waiters])
				if (idx >= w.from && w.pred(e)) {
					this.waiters.splice(this.waiters.indexOf(w), 1);
					w.resolve(e);
				}
		}
	}

	mark(): number {
		return this.events.length;
	}

	/** Resolve on the first event matching pred at or after `from`. */
	waitFor(
		pred: (e: Event) => boolean,
		opts: {from?: number; timeoutMs?: number; what?: string} = {},
	): Promise<Event> {
		const from = opts.from ?? 0;
		const hit = this.events.slice(from).find(pred);
		if (hit) return Promise.resolve(hit);
		return new Promise((resolve, reject) => {
			const w = {
				pred,
				from,
				resolve: (e: Event) => (clearTimeout(t), resolve(e)),
			};
			const t = setTimeout(() => {
				this.waiters.splice(this.waiters.indexOf(w), 1);
				reject(
					new Error(
						`${this.name}: timed out waiting for ${opts.what ?? 'event'}; last events: ${this.events
							.slice(-6)
							.map((e) => e.type)
							.join(', ')}`,
					),
				);
			}, opts.timeoutMs ?? 15_000);
			this.waiters.push(w);
		});
	}

	send(cmd: object): string {
		const id = `c${this.nextId++}`;
		this.proc.stdin.write(JSON.stringify({id, ...cmd}) + '\n');
		return id;
	}

	/** Send a prompt that starts no run (a slash command) and wait for pi's response to it. */
	async command(text: string): Promise<Event> {
		const from = this.mark();
		const id = this.send({type: 'prompt', message: text});
		return this.waitFor((e) => e.type === 'response' && e.id === id, {
			from,
			what: `response to ${text.slice(0, 40)}`,
		});
	}

	/**
	 * Wait until this pi is not running AND the test has read everything it
	 * emitted. pi writes events and responses to stdout in order, so once a
	 * `get_state` response is read, so is every event before it; a wake that
	 * ran entirely between two reads (seen under load) cannot then leak its
	 * events past the next prompt's mark.
	 */
	async settled(timeoutMs = 15_000): Promise<void> {
		const end = Date.now() + timeoutMs;
		for (;;) {
			const from = this.mark();
			const id = this.send({type: 'get_state'});
			const r = await this.waitFor(
				(e) => e.type === 'response' && e.id === id,
				{
					from,
					what: 'get_state',
				},
			);
			const last = this.events
				.filter((e) => e.type === 'agent_start' || e.type === 'agent_settled')
				.at(-1)?.type;
			if (!r.data?.isStreaming && last !== 'agent_start') return;
			if (Date.now() > end) throw new Error(`${this.name}: never settled`);
			await new Promise((res) => setTimeout(res, 50));
		}
	}

	/** Prompt and wait until the run fully settles. */
	async prompt(
		text: string,
		opts: {timeoutMs?: number} = {},
	): Promise<Event[]> {
		const from = this.mark();
		this.send({type: 'prompt', message: text});
		await this.waitFor((e) => e.type === 'agent_settled', {
			from,
			timeoutMs: opts.timeoutMs,
			what: `settle after prompt ${text.slice(0, 40)}`,
		});
		return this.events.slice(from);
	}

	async stop(): Promise<void> {
		if (this.proc.exitCode !== null || this.proc.signalCode !== null) return;
		try {
			process.kill(-this.proc.pid!, 'SIGTERM');
		} catch {}
		const killer = setTimeout(() => {
			try {
				process.kill(-this.proc.pid!, 'SIGKILL');
			} catch {}
		}, 3000);
		await this.exited;
		clearTimeout(killer);
	}
}

export interface World {
	root: string;
	stateDir: string;
	sessionDir: string;
	agentDir: string;
	procs: Pi[];
}

export function newWorld(): World {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kenning-pi-'));
	const w = {
		root,
		stateDir: path.join(root, 'state'),
		sessionDir: path.join(root, 'sessions'),
		agentDir: path.join(root, 'agent'),
		procs: [] as Pi[],
	};
	fs.mkdirSync(w.agentDir, {recursive: true});
	return w;
}

/**
 * Stop the world, and return the processes that LEAKED: still alive 3 s after
 * the test's own pi processes stopped. Spawned children lead their own process
 * groups, so stopping a test pi does not reach them; a host child is stopped by
 * its host's shutdown and a headless child exits when done, so anything left
 * after the grace period is a leak. They are killed by group either way, but
 * the caller asserts on the list (invariant 8), so a leak fails the suite.
 */
export async function endWorld(w: World): Promise<number[]> {
	await Promise.all(w.procs.map((p) => p.stop()));
	const grace = Date.now() + 3000;
	while (survivors(w).length && Date.now() < grace)
		await new Promise((r) => setTimeout(r, 50));
	const leaked = survivors(w);
	for (const pid of leaked) {
		try {
			process.kill(-pid, 'SIGKILL');
		} catch {}
		try {
			process.kill(pid, 'SIGKILL');
		} catch {}
	}
	const end = Date.now() + 3000;
	while (survivors(w).length && Date.now() < end)
		await new Promise((r) => setTimeout(r, 50));
	fs.rmSync(w.root, {recursive: true, force: true});
	return leaked;
}

/**
 * Every live process started for this world, at any depth: they all carry
 * KENNING_STATE_DIR=<this world's state dir> in their environment. Reads
 * /proc/<pid>/environ (Linux); a process we may not read is not ours.
 */
export function survivors(w: World): number[] {
	const needle = Buffer.from(`KENNING_STATE_DIR=${w.stateDir}\0`);
	const out: number[] = [];
	let pids: string[] = [];
	try {
		pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d));
	} catch {
		return out;
	}
	for (const d of pids) {
		const pid = Number(d);
		if (pid === process.pid) continue;
		try {
			if (fs.readFileSync(`/proc/${d}/environ`).includes(needle)) {
				const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
				if (stat.slice(stat.lastIndexOf(')') + 2)[0] !== 'Z') out.push(pid);
			}
		} catch {}
	}
	return out;
}

/** True if any process of these groups is still alive. */
export function anyAlive(procs: Pi[]): number[] {
	const alive: number[] = [];
	for (const p of procs) {
		try {
			process.kill(-p.proc.pid!, 0);
			alive.push(p.proc.pid!);
		} catch {}
	}
	return alive;
}

/** The assistant texts and tool results a run produced, for assertions. */
export function texts(events: Event[]): string[] {
	return events
		.filter((e) => e.type === 'message_end')
		.map((e) => e.message)
		.filter((m) => m.role !== 'system')
		.map(
			(m) =>
				`${m.role}${m.customType ? ':' + m.customType : ''}: ${typeof m.content === 'string' ? m.content : (m.content ?? []).map((c: any) => c.text ?? (c.type === 'toolCall' ? `[call ${c.name}]` : '')).join(' ')}`,
		);
}
