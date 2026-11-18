import type {DeliveryPlan} from './delivery.js';
import type {AttentionItem, Message} from './types.js';

/**
 * The event a host emits on a pi session's event bus (`pi.events`) right before
 * it sends a human's text into that session, so kenning records the turn as a
 * human act (ADR 0003, D22). Only extension code can reach the bus; the model
 * cannot. Emit it for web, Telegram or any authenticated human channel; never
 * for scheduled or agent-originated sends.
 */
export const HUMAN_INPUT_EVENT = 'kenning:human-input';

export interface HumanInputMark {
	text: string;
	/** Where the human typed it: `web`, `telegram`, ... */
	channel: string;
	/** Optional: names this mark, so its end event closes exactly this one. */
	id?: string;
}

/**
 * The event a host emits once its marked send attempt has SETTLED: the awaited
 * `prompt()` resolved or threw (D35). kenning then drops the mark if no input
 * consumed it, so a send that never reached the `input` handlers (another
 * extension returned `handled`, pi refused it while compacting) leaves nothing
 * behind, with no window. Give the mark's `id` to close exactly that mark;
 * without one, the oldest open mark with this text and no id is closed (a mark
 * that has an id is closed only by it).
 *
 * Emit it ONLY after awaiting the send. Never after `pi.sendUserMessage()`
 * from an extension: that call is fire-and-forget in pi 1.4 (it returns before
 * the `input` handlers run and reports failures only as `extension_error`), so
 * an end emitted after it can drop a mark that was about to match. Such a host
 * emits no end event and relies on the mark's 5 s expiry. Also wrong, though
 * safe: a `prompt()` called while pi is emitting `agent_settled` is deferred
 * and resolves before its input runs, so the end drops the mark and that send
 * is not recorded as the human's (it fails toward "not human").
 */
export const HUMAN_INPUT_END_EVENT = 'kenning:human-input-end';

export interface HumanInputEnd {
	text: string;
	id?: string;
}

/**
 * A session asks its host for a new session it will own (D23, D28). kenning has
 * already recorded the spawn (`spawnId`) and created the worktree, if any.
 */
export interface SpawnRequest {
	/** The ownership record kenning made for this spawn (`sp_...`). */
	spawnId: string;
	/** The owner's session file. One host serves many sessions, so this says whose child it is. */
	owner: string;
	/** Absolute folder the new session runs in (the worktree, when one was asked for). */
	folder: string;
	/**
	 * A short label for the new session (the role, else the prompt's first line,
	 * at most 80 characters), for a sidebar. The prompt itself is NOT the host's
	 * to send: kenning delivers it as a message from the owner, origin agent, once
	 * the session exists (D28). A host must send nothing into the new session and
	 * must never emit a human-input mark for it.
	 */
	title: string;
	/** The role kenning will claim for the new session. */
	role?: string;
	/** Start from this transcript (up to `entryId`, else all of it) instead of an empty one. */
	fork?: {sessionFile: string; entryId?: string};
	/** Informational: the worktree kenning created for `folder`. */
	worktree?: {repo: string; branch: string; path: string};
}

export interface SpawnResult {
	/** The new session's transcript path, which kenning binds to the spawn. */
	sessionFile: string;
}

/**
 * What a host did with a stop. `not-mine`: this host does not run that session;
 * kenning then asks the session's own extension to stop (D30).
 */
export type StopOutcome = 'stopped' | 'not-running' | 'not-mine';

/**
 * How a host delivers, notifies, spawns and stops (D20). The pi extension is the
 * default host for a terminal pi; wherever implements its own through its
 * session pool. Every member is optional: a host provides what it can.
 */
export interface KenningHost {
	/** Deliver messages into a session the host runs. 'held' leaves them pending. */
	deliver?(
		sessionFile: string,
		messages: Message[],
		plan: DeliveryPlan,
	): Promise<'done' | 'held'>;
	/** Tell the human about a new attention item (push, Telegram). */
	notifyHuman?(item: AttentionItem): Promise<void>;
	/**
	 * Create a session owned by `req.owner` in `req.folder` and resolve as soon
	 * as it exists and is addressable (its transcript path is final and its
	 * kenning extension will start in it), NOT when a first turn ends: the new
	 * session starts with no prompt and kenning wakes it with the owner's message.
	 * Reject to refuse; the agent sees the error.
	 */
	spawn?(req: SpawnRequest): Promise<SpawnResult>;
	/**
	 * Stop the CURRENT TURN of `sessionFile` (abort its running agent), leaving
	 * the session itself alive, and nothing else: stopping never cascades to the
	 * sessions it owns. `by` is the session asking (kenning already checked that
	 * it owns the target). Null is reserved for the human; today `kenning stop`
	 * does not call the host, it records a stop request that the session's own
	 * extension acts on (D30).
	 */
	stop?(sessionFile: string, opts: {by: string | null}): Promise<StopOutcome>;
}

/**
 * The per-process host registry (D26). It lives on `globalThis` under a
 * `Symbol.for` key, not in this module, so a host that loaded ANOTHER copy of
 * kenning (wherever's server, the @wherever-dev/pi bridge, a jiti-loaded
 * extension) fills the same registry kenning-pi reads. The same pattern as
 * wherever's `Symbol.for('wherever-dev.server-process')` marker; the key string
 * is a contract between packages, so it never changes. The shape is versioned
 * for the same reason.
 */
export const HOST_REGISTRY_KEY = Symbol.for('kenning.host');

interface HostRegistry {
	version: 1;
	entries: {host: KenningHost}[];
}

function registry(): HostRegistry {
	const g = globalThis as unknown as Record<symbol, HostRegistry | undefined>;
	let r = g[HOST_REGISTRY_KEY];
	if (!r || !Array.isArray(r.entries))
		r = g[HOST_REGISTRY_KEY] = {version: 1, entries: []};
	return r;
}

/**
 * Register this process's host. The most recently registered host wins; the
 * returned function unregisters it and restores the previous one (registering
 * the same object twice gives two entries, each removed by its own call).
 */
export function registerHost(host: KenningHost): () => void {
	const entry = {host};
	registry().entries.push(entry);
	return () => {
		const entries = registry().entries;
		const i = entries.indexOf(entry);
		if (i >= 0) entries.splice(i, 1);
	};
}

/** The host registered last in this process, or undefined for the terminal default. */
export function currentHost(): KenningHost | undefined {
	const entries = registry().entries;
	return entries[entries.length - 1]?.host;
}
