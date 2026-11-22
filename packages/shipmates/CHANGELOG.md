# shipmates

## 0.1.1

### Patch Changes

- 2cb0c5b: A session that declared `waiting-for-human` now wakes when the human answers it. Before, an answer given from the inbox (`kenning answer`, or a host's inbox such as wherever's web and Telegram) was held like any other message until the human also typed into that session, so a session that asked a non-blocking `human_ask` and then waited, as the guidelines say, never saw the answer by itself. Messages from other sessions are still held for the human's next turn, and nothing wakes a session while the human is typing into it or with `/kenning wake off` (spec D37).

## 0.1.0

### Minor Changes

- 377783a: First milestone: presence and roles, messages with provenance (human, agent, human-relayed), questions with answers and waiting, the human's attention inbox, supersede and withdraw, retention, and the `kenning` CLI; the pi extension delivers at pi's boundary hooks (before settling, at turn end, waking idle sessions, holding for the human's next turn).
- 2ac04de: Spawn, stop and ownership. The core records who spawned which session (a new migration; ownership is set once, outlives presence, is transitive, and is kept while the session's transcript exists), marks archive and delete cascades as one batch undoable for 7 days, and records stop requests. `registerHost` / `currentHost` give each process one host registry on `globalThis[Symbol.for('kenning.host')]`, shared across copies of the module; `KenningHost.spawn` resolves `{sessionFile}` as soon as the session exists, and `stop(sessionFile, {by})` stops only its current turn. The CLI adds `kenning owned <target>` and `kenning stop <target>` (the human at a terminal only). The pi extension adds `session_spawn` (through the registered host, else a zellij pane or a detached headless `pi -p` woken later by its owner; optional worktree under `~/dev/worktrees/<repo>/<branch>` and fork) and `session_stop` (refused unless the caller owns the target). A spawned session's first prompt arrives as a `spawn` message from its owner, origin agent. `session_list`, `session_read` and `/kenning` show owners and owned sessions. An aborted run (a stop, or Esc) is no longer continued or re-woken by messages that were already pending.

### Patch Changes

- 2ac04de: A host's `kenning:human-input` mark is now valid for 5 s after it is emitted and is then dropped, never matched. Before, a mark whose send never reached kenning-pi's `input` handler (another extension handled the input, or a terminal pi refused the send while compacting) stayed queued, and a later identical `extension`-sourced input in that session, such as a scheduled job's prompt, was recorded as a human turn and could be relayed as `human-relayed`. A host that awaits its send can now close its mark at once with `kenning:human-input-end` `{text, id?}` (exported as `HUMAN_INPUT_END_EVENT` from `kenning`; marks may carry an `id`); the 5 s expiry stays as the backstop for fire-and-forget sends. Also, a `pi -p` prompt (which pi reports as source `interactive`) is a human turn only at a terminal outside an agent session.
