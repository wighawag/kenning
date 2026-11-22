// A stand-in for wherever's server: ONE long-lived pi session built with the
// SDK and bound in print mode with no UI, exactly as wherever's SessionPool
// binds every server session (`mode: 'print'`, `uiContext` unset). It prompts
// the session once with argv[2], then stays up and never prompts it again, so
// anything the session does afterwards it started itself. With
// PRINT_HOST_WHEREVER=1 it sets wherever's server-process marker first, as the
// pool does before any extension loads. Run with node (type stripping); stops
// on SIGTERM. Prints `{"type":"ready","sessionFile":...}` once the first
// prompt settled, a JSON line like the rpc events the harness reads.
//
// It then reads JSON lines on stdin, each a send as wherever's server makes
// one: `{"type":"send","id","text","channel"?,"source"?,"streamingBehavior"?}`.
// With `channel`, it first emits the `shipmates:human-input` mark on the
// session's bus (a human's send, D22); without, the send is unmarked (an agent
// or a schedule). It prints `{"type":"preflight","id","disposition"}` as pi
// decides what to do with it, and `{"type":"sent","id","error"?}` once the
// awaited prompt() settles.
import path from 'node:path';
import readline from 'node:readline';
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRegistry,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from '@earendil-works/pi-coding-agent';

const here = path.dirname(new URL(import.meta.url).pathname);
const SHIPMATES_PI = path.resolve(here, '../../src/index.ts');
const BRAIN = path.resolve(here, 'brain.ts');

if (process.env.PRINT_HOST_WHEREVER === '1')
	(globalThis as any)[Symbol.for('wherever-dev.server-process')] = true;

let events: {emit(name: string, data: unknown): void} | null = null;
const cwd = process.cwd();
const agentDir = process.env.PI_CODING_AGENT_DIR!;
const sessionDir = process.env.SHIPMATES_TEST_SESSION_DIR!;
const settingsManager = SettingsManager.inMemory({});
const resourceLoader = new DefaultResourceLoader({
	cwd,
	agentDir,
	settingsManager,
	noExtensions: true,
	noSkills: true,
	noPromptTemplates: true,
	noContextFiles: true,
	additionalExtensionPaths: [SHIPMATES_PI, BRAIN],
	// The session's own bus, as wherever's human-input marker captures it.
	extensionFactories: [
		{
			name: 'test-human-input',
			factory: (pi) => {
				events = pi.events;
			},
		},
	],
});
await resourceLoader.reload();

// The brain registers its provider at load time; nothing flushes it outside a
// CLI or a bind, so register it the way wherever does (registerExtensionProviders).
const runtime = await ModelRuntime.create({
	authPath: path.join(agentDir, 'auth.json'),
	modelsPath: path.join(agentDir, 'models.json'),
});
const models = new ModelRegistry(runtime);
const ext = resourceLoader.getExtensions().runtime;
for (const {name, config} of ext.pendingProviderRegistrations)
	models.registerProvider(name, config);
ext.pendingProviderRegistrations = [];

const {session} = await createAgentSession({
	cwd,
	agentDir,
	modelRuntime: runtime,
	model: models.find('faux', 'brain'),
	settingsManager,
	resourceLoader,
	sessionManager: SessionManager.create(cwd, sessionDir),
});
await session.bindExtensions({mode: 'print'});

await session.prompt(process.argv[2] ?? 'hello');
console.log(
	JSON.stringify({
		type: 'ready',
		sessionFile: session.sessionManager.getSessionFile(),
	}),
);

const out = (o: object) => console.log(JSON.stringify(o));
readline.createInterface({input: process.stdin}).on('line', (line) => {
	let cmd: any;
	try {
		cmd = JSON.parse(line);
	} catch {
		return;
	}
	if (cmd.type !== 'send') return;
	if (cmd.channel)
		events?.emit('shipmates:human-input', {
			text: cmd.text,
			channel: cmd.channel,
		});
	session
		.prompt(cmd.text, {
			source: cmd.source ?? 'extension',
			expandPromptTemplates: false,
			streamingBehavior: cmd.streamingBehavior ?? 'steer',
			preflightResult: (disposition) =>
				out({type: 'preflight', id: cmd.id, disposition}),
		})
		.then(
			() => out({type: 'sent', id: cmd.id}),
			(e) => out({type: 'sent', id: cmd.id, error: String(e?.message ?? e)}),
		);
});

// Teardown as wherever's shutdownAndDisposeAgentSession does it: abort, then
// session_shutdown to the extensions (dispose() alone does not emit it), then
// dispose. shipmates unregisters its presence there.
const stop = async () => {
	try {
		session.agent.abort();
		await session.extensionRunner.emit({
			type: 'session_shutdown',
			reason: 'quit',
		});
	} catch {}
	session.dispose();
	process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
setInterval(() => {}, 1 << 30);
