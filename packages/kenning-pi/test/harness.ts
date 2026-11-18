import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const KENNING_PI = path.resolve(here, '../src/index.ts');
const BRAIN = path.resolve(here, 'fixtures/brain.ts');
const HOST = path.resolve(here, 'fixtures/host.ts');

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
		const env: NodeJS.ProcessEnv = {
			...process.env,
			KENNING_STATE_DIR: world.stateDir,
			KENNING_POLL_MS: '100',
			PI_CODING_AGENT_DIR: world.agentDir,
			PI_OFFLINE: '1',
			PI_SKIP_VERSION_CHECK: '1',
		};
		delete env.PI_SUBAGENT_CHILD;
		delete env.KENNING_ROLE;
		const proc = spawn(
			'pi',
			[
				'--mode',
				'rpc',
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
				...extra,
			],
			{cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe']},
		) as ChildProcessWithoutNullStreams;
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

	send(cmd: object): void {
		this.proc.stdin.write(
			JSON.stringify({id: `c${this.nextId++}`, ...cmd}) + '\n',
		);
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

export async function endWorld(w: World): Promise<void> {
	await Promise.all(w.procs.map((p) => p.stop()));
	fs.rmSync(w.root, {recursive: true, force: true});
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
