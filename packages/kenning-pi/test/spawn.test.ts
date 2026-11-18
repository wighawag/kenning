import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {openKenning, type Kenning} from 'kenning';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {
	anyAlive,
	endWorld,
	FAKE_HOST,
	newWorld,
	Pi,
	survivors,
	texts,
	type Event,
	type World,
} from './harness.js';

const quiet = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function eventually<T>(
	read: () => T,
	ok: (v: T) => boolean,
	ms = 10_000,
): Promise<T> {
	const end = Date.now() + ms;
	let v = read();
	while (!ok(v) && Date.now() < end) {
		await quiet(50);
		v = read();
	}
	return v;
}
const toolResult = (events: Event[], name: string) =>
	JSON.stringify(
		events.find((e) => e.type === 'tool_execution_end' && e.toolName === name)
			?.result ?? null,
	);
const pgidOf = (pid: number) => {
	const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
	return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]);
};
const jsonl = (file: string) =>
	fs
		.readFileSync(file, 'utf8')
		.split('\n')
		.filter(Boolean)
		.map((l) => JSON.parse(l));

/** A message with this text reached its receiver's transcript (boundary entries emit no message_end). */
async function delivered(k: Kenning, text: string) {
	const row = () =>
		k.db
			.prepare(
				`SELECT state FROM message WHERE text = ? AND state = 'delivered'`,
			)
			.get(text);
	const ok = await eventually(row, (r) => !!r, 15_000);
	if (!ok) {
		// Say why: every message, and the spawn logs of headless children.
		const dir = path.join(path.dirname(k.db.location()!), 'spawn-logs');
		const logs = fs.existsSync(dir)
			? fs
					.readdirSync(dir)
					.map(
						(f) =>
							`${f}:\n${fs.readFileSync(path.join(dir, f), 'utf8').slice(-2000)}`,
					)
			: [];
		const all = k.db
			.prepare(`SELECT kind, from_label, to_target, state, text FROM message`)
			.all();
		expect.fail(
			`no delivery of ${text}\n${JSON.stringify(all, null, 1)}\n${logs.join('\n')}`,
		);
	}
}

async function finish(w: World, ks: Kenning[]) {
	for (const k of ks) k.close();
	const errors = w.procs.flatMap((p) =>
		p.events
			.filter((e) => e.type === 'extension_error')
			.map((e) => `${p.name}: ${JSON.stringify(e).slice(0, 400)}`),
	);
	const procs = w.procs;
	const leaked = await endWorld(w);
	expect(leaked).toEqual([]);
	expect(errors).toEqual([]);
	expect(anyAlive(procs)).toEqual([]);
	expect(survivors(w)).toEqual([]);
}

describe('a host spawns a child the orchestrator owns', () => {
	let w: World;
	let k: Kenning;
	let orch: Pi, other: Pi;
	let child: string;

	beforeAll(async () => {
		w = newWorld();
		fs.mkdirSync(path.join(w.root, 'child'));
		orch = Pi.start(w, 'orch', ['-e', FAKE_HOST]);
		other = Pi.start(w, 'other');
		k = openKenning({stateDir: w.stateDir});
		await orch.prompt('DO session_register {"role":"orchestrator:t"}');
		await other.prompt('DO session_register {"role":"t/other"}');
	}, 60_000);

	afterAll(() => finish(w, [k]), 30_000);

	it("the child's first prompt arrives from the owner, origin agent, and the child answers back", async () => {
		const spawned = await orch.prompt(
			'DO session_spawn {"folder":"../child","role":"t/child","prompt":"first job: say hello. DO session_tell {\\"target\\":\\"orchestrator:t\\",\\"text\\":\\"child here, hello\\"}"}',
		);
		expect(toolResult(spawned, 'session_spawn')).toContain('via host');
		child = k.roleHolder('t/child')!;
		expect(child).toMatch(/\.jsonl$/);
		expect(k.ownerOf(child)).toBe(k.roleHolder('orchestrator:t'));

		// What kenning asked the host: an owner, a folder, a title, no prompt to send.
		const [req] = jsonl(path.join(w.root, 'host.jsonl'));
		expect(req).toMatchObject({
			type: 'spawn',
			req: {
				owner: k.roleHolder('orchestrator:t'),
				folder: path.join(w.root, 'child'),
				title: 't/child',
				role: 't/child',
			},
		});
		expect(req.req.prompt).toBeUndefined();

		// The child answered: the orchestrator is woken by it.
		await delivered(k, 'child here, hello');
		const first = k.db
			.prepare(`SELECT id FROM message WHERE kind = 'spawn'`)
			.get() as {id: string};
		expect(k.message(first.id)).toMatchObject({
			kind: 'spawn',
			origin: 'agent',
			from: k.roleHolder('orchestrator:t'),
			fromLabel: 'orchestrator:t',
			state: 'delivered',
			deliveredTo: child,
		});
		// In the child's transcript as a kenning message from its owner; never a human turn.
		const entries = jsonl(child);
		const entry = entries.find(
			(e) => e.type === 'custom_message' && e.customType === 'kenning',
		);
		expect(
			entry?.details,
			JSON.stringify(entries.map((e) => e.type)),
		).toMatchObject({
			ids: [first.id],
			from: ['orchestrator:t'],
			origins: ['agent'],
		});
		expect(JSON.stringify(entry.content)).toContain(
			'spawned this session and owns it',
		);
		expect(() => k.relayFromHuman(child, {})).toThrow(/no human turn/);

		// Both sides can see the relationship. The child's message woke the
		// orchestrator: wait until that run is over and the test has read all of
		// it, or the next prompt lands on a busy session, or the wake's events
		// (still in the pipe) land after the prompt's mark (both seen under load).
		await orch.settled();
		const listed = texts(await orch.prompt('DO session_list {}')).join('\n');
		expect(listed).toContain('owns 1:');
		expect(listed).toContain('owner: orchestrator:t');
	}, 60_000);

	it("a non-owner's session_stop is refused", async () => {
		const events = await other.prompt('DO session_stop {"target":"t/child"}');
		expect(toolResult(events, 'session_stop')).toContain('you do not own');
		expect(
			jsonl(path.join(w.root, 'host.jsonl')).filter((e) => e.type === 'stop'),
		).toEqual([]);
		expect(k.openStops(child)).toEqual([]);
	}, 30_000);

	it("the owner's session_stop aborts the child's running turn and nothing else", async () => {
		// The child starts a long tool call; another session runs a short one.
		await orch.prompt(
			'DO session_tell {"target":"t/child","text":"DO bash {\\"command\\":\\"sleep 20\\"}"}',
		);
		expect(
			await eventually(
				() => k.presence(child)!.state,
				(s) => s === 'running',
			),
		).toBe('running');
		const fromOther = other.mark();
		other.send({type: 'prompt', message: 'DO bash {"command":"sleep 1.5"}'});
		await other.waitFor(
			(e) => e.type === 'tool_execution_start' && e.toolName === 'bash',
			{from: fromOther, what: 'other to start its bash'},
		);
		await quiet(300); // the child is inside its sleep too

		const t0 = Date.now();
		const stopped = await orch.prompt('DO session_stop {"target":"t/child"}');
		expect(toolResult(stopped, 'session_stop')).toContain(
			'stopped the current turn',
		);
		expect(
			await eventually(
				() => k.presence(child)!.state,
				(s) => s === 'idle',
			),
		).toBe('idle');
		const stopMs = Date.now() - t0;
		console.log(`[measure] host stop to child idle: ${stopMs} ms`);
		expect(stopMs).toBeLessThan(5_000); // not the 20 s sleep
		expect(k.isLive(child)).toBe(true); // the session stays
		// The child's own event stream: its run ended aborted, by the host's RPC
		// abort (the file is written asynchronously, so wait for the line).
		const settledRuns = await eventually(
			() =>
				jsonl(path.join(w.root, 'child-0.events')).filter(
					(e) => e.type === 'agent_settled',
				),
			(runs) => runs.length >= 2,
		);
		expect(settledRuns.map((e) => e.aborted)).toEqual([false, true]); // the first prompt, then the stopped sleep
		expect(
			jsonl(path.join(w.root, 'host.jsonl')).filter((e) => e.type === 'stop'),
		).toEqual([
			{type: 'stop', sessionFile: child, by: k.roleHolder('orchestrator:t')},
		]);

		// The other session's run was not touched.
		await other.waitFor((e) => e.type === 'agent_settled', {
			from: fromOther,
			what: 'other to finish',
		});
		const otherRun = other.events.slice(fromOther);
		expect(otherRun.find((e) => e.type === 'agent_settled')!.aborted).toBe(
			false,
		);
		expect(
			otherRun.find(
				(e) => e.type === 'tool_execution_end' && e.toolName === 'bash',
			)!.isError,
		).toBe(false);
		// The owner's own run was not aborted either.
		expect(stopped.find((e) => e.type === 'agent_settled')!.aborted).toBe(
			false,
		);

		// The stopped child takes the next message as usual.
		await orch.prompt(
			'DO session_tell {"target":"t/child","text":"DO session_register {\\"status\\":\\"back after the stop\\"}"}',
		);
		expect(
			await eventually(
				() => k.presence(child)!.status,
				(s) => s === 'back after the stop',
			),
		).toBe('back after the stop');
	}, 60_000);
});

describe('the terminal default: a headless pi -p child', () => {
	let w: World;
	let k: Kenning;
	let orch: Pi;
	let child: string;

	beforeAll(async () => {
		w = newWorld();
		const repo = path.join(w.root, 'repo');
		fs.mkdirSync(repo);
		const git = (...args: string[]) =>
			execFileSync('git', ['-C', repo, ...args], {
				stdio: 'ignore',
				env: {
					...process.env,
					GIT_AUTHOR_NAME: 't',
					GIT_AUTHOR_EMAIL: 't@t',
					GIT_COMMITTER_NAME: 't',
					GIT_COMMITTER_EMAIL: 't@t',
				},
			});
		git('init', '-q', '-b', 'main');
		git('commit', '-q', '--allow-empty', '-m', 'root');
		orch = Pi.start(w, 'orch');
		k = openKenning({stateDir: w.stateDir});
		await orch.prompt('DO session_register {"role":"orchestrator:h"}');
	}, 60_000);

	afterAll(() => finish(w, [k]), 30_000);

	it('spawns into a new worktree, in its own process group; the first prompt joins the -p run, and the child answers', async () => {
		const events = await orch.prompt(
			'DO session_spawn {"folder":"../repo","role":"h/child","worktree":{"branch":"lane-a"},"prompt":"DO bash {\\"command\\":\\"sleep 0.5\\"}\\nDO session_tell {\\"target\\":\\"orchestrator:h\\",\\"text\\":\\"headless here\\"}"}',
		);
		const result = toolResult(events, 'session_spawn');
		expect(result).toContain('via headless');
		console.log(
			`[measure] headless spawn: ${result.match(/up in \d+ ms/)?.[0]}`,
		);
		const wt = path.join(w.root, 'worktrees', 'repo', 'lane-a');
		expect(
			execFileSync('git', ['-C', wt, 'rev-parse', '--abbrev-ref', 'HEAD'], {
				encoding: 'utf8',
			}).trim(),
		).toBe('lane-a');
		child = k.roleHolder('h/child')!;
		expect(k.ownership(child)).toMatchObject({
			via: 'headless',
			folder: wt,
			owner: k.roleHolder('orchestrator:h'),
			detail: {worktree: {branch: 'lane-a', path: wt}},
		});
		// Its own process group, while it runs.
		const p = await eventually(
			() => k.presence(child),
			(x) => !!x?.live,
		);
		expect(pgidOf(p!.pid)).toBe(p!.pid);
		expect(p!.cwd).toBe(wt);

		await delivered(k, 'headless here');
		// Done: the -p run exits, and its kickoff line was never the human.
		expect(
			await eventually(
				() => k.isLive(child),
				(live) => !live,
			),
		).toBe(false);
		expect(() => k.relayFromHuman(child, {})).toThrow(/no human turn/);
	}, 60_000);

	it('a message to the child, not running, wakes it with pi --session <path> -p', async () => {
		const t0 = Date.now();
		await orch.prompt(
			'DO session_tell {"target":"h/child","text":"DO session_tell {\\"target\\":\\"orchestrator:h\\",\\"text\\":\\"woken again\\"}"}',
		);
		await delivered(k, 'woken again');
		console.log(`[measure] headless wake round trip: ${Date.now() - t0} ms`);
		expect(k.pendingFor(child)).toEqual([]);
		expect(k.roleHolder('h/child')).toBe(child); // the same session, resumed
	}, 60_000);

	it('a fork starts from the owner transcript: all of it, or the branch up to an entry', async () => {
		const source = k.roleHolder('orchestrator:h')!;
		const entries = jsonl(source);
		const firstUser = entries.find(
			(e) => e.type === 'message' && e.message.role === 'user',
		);
		const spawnOne = async (fork: object, word: string) => {
			const events = await orch.prompt(
				`DO session_spawn {"folder":".","fork":${JSON.stringify(fork)},"prompt":"DO session_tell {\\"target\\":\\"orchestrator:h\\",\\"text\\":\\"${word}\\"}"}`,
			);
			const r = JSON.parse(toolResult(events, 'session_spawn'));
			expect(r.details?.sessionFile, JSON.stringify(r)).toBeTruthy();
			await delivered(k, word);
			return r.details.sessionFile as string;
		};
		const whole = jsonl(await spawnOne({sessionFile: source}, 'forked whole'));
		const cut = jsonl(
			await spawnOne(
				{sessionFile: source, entryId: firstUser.id},
				'forked at an entry',
			),
		);
		for (const t of [whole, cut]) expect(t[0].parentSession).toBe(source);
		const said = (t: any[]) =>
			t
				.filter((e) => e.type === 'message' && e.message.role === 'user')
				.map((e) => JSON.stringify(e.message.content));
		// The whole fork has the owner's later prompts; the cut one stops at the entry.
		expect(said(whole).some((x) => x.includes('woken again'))).toBe(true);
		expect(said(cut).some((x) => x.includes('woken again'))).toBe(false);
		expect(said(cut)[0]).toContain('orchestrator:h');
	}, 60_000);

	it("the owner's session_stop ends the child's running turn; it is not woken again", async () => {
		await orch.prompt(
			'DO session_tell {"target":"h/child","text":"DO bash {\\"command\\":\\"sleep 20\\"}"}',
		);
		expect(
			await eventually(
				() => k.presence(child)?.state,
				(s) => s === 'running',
			),
		).toBe('running');
		await quiet(300);
		const t0 = Date.now();
		const stopped = await orch.prompt('DO session_stop {"target":"h/child"}');
		expect(
			toolResult(stopped, 'session_stop'),
			texts(stopped).join('\n'),
		).toContain('stopped the current turn');
		expect(
			await eventually(
				() => k.isLive(child),
				(live) => !live,
			),
		).toBe(false);
		console.log(
			`[measure] stop request to headless exit: ${Date.now() - t0} ms`,
		);
		expect(
			k.db
				.prepare(
					`SELECT outcome, by_label FROM stop_request WHERE session_file = ?`,
				)
				.all(child),
		).toEqual([{outcome: 'stopped', by_label: 'orchestrator:h'}]);
		await quiet(1500);
		expect(k.isLive(child)).toBe(false);
		// Nothing but the orchestrator's own group is left: the child and its sleep are gone.
		expect(survivors(w).filter((pid) => pgidOf(pid) !== orch.proc.pid)).toEqual(
			[],
		);
	}, 60_000);
});
