// A stand-in for wherever's server: ONE long-lived pi session built with the
// SDK and bound in print mode with no UI, exactly as wherever's SessionPool
// binds every server session (`mode: 'print'`, `uiContext` unset). It prompts
// the session once with argv[2], then stays up and never prompts it again, so
// anything the session does afterwards it started itself. With
// PRINT_HOST_WHEREVER=1 it sets wherever's server-process marker first, as the
// pool does before any extension loads. Run with node (type stripping); stops
// on SIGTERM. Prints `{"type":"ready","sessionFile":...}` once the first
// prompt settled, a JSON line like the rpc events the harness reads.
import path from 'node:path';
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRegistry,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from '@earendil-works/pi-coding-agent';

const here = path.dirname(new URL(import.meta.url).pathname);
const KENNING_PI = path.resolve(here, '../../src/index.ts');
const BRAIN = path.resolve(here, 'brain.ts');

if (process.env.PRINT_HOST_WHEREVER === '1')
	(globalThis as any)[Symbol.for('wherever-dev.server-process')] = true;

const cwd = process.cwd();
const agentDir = process.env.PI_CODING_AGENT_DIR!;
const sessionDir = process.env.KENNING_TEST_SESSION_DIR!;
const settingsManager = SettingsManager.inMemory({});
const resourceLoader = new DefaultResourceLoader({
	cwd,
	agentDir,
	settingsManager,
	noExtensions: true,
	noSkills: true,
	noPromptTemplates: true,
	noContextFiles: true,
	additionalExtensionPaths: [KENNING_PI, BRAIN],
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

// Teardown as wherever's shutdownAndDisposeAgentSession does it: abort, then
// session_shutdown to the extensions (dispose() alone does not emit it), then
// dispose. kenning unregisters its presence there.
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
