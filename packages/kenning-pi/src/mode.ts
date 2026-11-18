/**
 * How the process kenning runs in shapes two decisions (D36): whether a
 * session may wake itself, and whether an `interactive` input can be the human
 * at a terminal. pi's `print` and `json` modes cover two very different things:
 * a one-shot `pi -p` run, which drives its own prompt and exits, and wherever's
 * server, which runs every session in print mode (`hasUI` false) but keeps it
 * alive and never prompts it on its own. wherever's SessionPool marks its
 * process with this key; the key string is a contract between the packages, so
 * it never changes (the same pattern as `kenning.host`, D26).
 */
export const WHEREVER_SERVER_KEY = Symbol.for('wherever-dev.server-process');

/** True inside wherever's server process. Read per call: the marker may be set after this module loads. */
export function inWhereverServer(): boolean {
	return (
		(globalThis as unknown as Record<symbol, unknown>)[WHEREVER_SERVER_KEY] ===
		true
	);
}

export type PiMode = 'tui' | 'print' | 'json' | 'rpc' | (string & {});

/**
 * May a settled, idle session start a turn for its own pending messages?
 * A real `pi -p` (print or json mode, no wherever marker) may not: print mode
 * prompts right after `session_start`, and a wake there made that prompt fail
 * with "Agent is already processing" (measured); its messages join the prompt
 * at `before_agent_start`, later ones wait for the owner's next wake (D29).
 * Inside wherever the session is a long-lived headless host and nothing else
 * would ever deliver to it, so it wakes like any other (D36).
 */
export function mayWakeItself(p: {
	mode: PiMode;
	inWhereverServer: boolean;
}): boolean {
	if (p.mode === 'print' || p.mode === 'json') return p.inWhereverServer;
	return true;
}

/**
 * May an input pi reports as source `interactive` be the human typing at a
 * terminal (ADR 0003, D27)? In the TUI, yes. Inside wherever, never: its
 * server calls `prompt()` with the default source for every send, and a human
 * act there is only a host's `kenning:human-input` mark, whatever the server's
 * stdin is (a dev server started in a terminal has a TTY). Otherwise only under
 * the CLI's rule (D2): a terminal on stdin and no agent session around it.
 */
export function mayBeTerminalHuman(p: {
	mode: PiMode;
	inWhereverServer: boolean;
	stdinIsTTY: boolean;
	inAgentSession: boolean;
}): boolean {
	if (p.mode === 'tui') return true;
	if (p.inWhereverServer) return false;
	return p.stdinIsTTY && !p.inAgentSession;
}
