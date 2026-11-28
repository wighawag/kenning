# shipmates

## 0.5.0

### Minor Changes

- 49fdddd: A status line that lags no longer passes for the truth, and the human's answer reaches a running session at the turn end (spec D41).

  - `shipmates`: `planDelivery` delivers a pending message of origin `human` to a running session `at-turn-end`, as an urgent one. New reads `outstandingItems(session)` (items it raised that are open, or answered with the answer not yet delivered to it), `itemStatus(id)` (type `ItemStatus` with `answerPending`) and `statusFacts(session, status?)` (type `StatusFacts`: those items, plus each `h_`/`q_` id the status names that is no longer open, type `StatusRef`); formatters `formatStatusFacts`, `formatStatusRef`, `formatItemFact`; `Question.finishedAt`. The CLI's `list` and `read` print the facts under the status. No migration.
  - `@shipmates/pi`: the human's answer (and any origin-`human` message) is delivered at the next `turn_end` of a running session instead of when its run settles, so a non-blocking `human_ask`'s answer arrives while the agent still works. `session_list`, `session_read`, `session_tell`, `session_wait` and `/shipmates` show the derived facts under each status; `session_register` notes when your own status names an item whose answer you have already read. The guidelines and the skill tell readers to trust those lines over status text.

## 0.4.0

### Minor Changes

- c80257f: `/shipmates wake off` and a declared `waiting-for-human` now survive a session being unloaded and loaded again (wherever's pool, a server restart, `pi --resume`) (spec D40).

  - `shipmates`: migration 3 adds the `session_setting` table, kept per transcript file and pruned only once the transcript is gone. `update(file, {wake})` writes it; new `update(file, {declaredWaiting})`; `Presence.declaredWaiting`; new reads `settings()` and `setting(file)` (type `SessionSetting`) for a host showing sessions with no live presence; `register` restores `waiting-for-human` for a session that declared it and has not run since. A fork (a new file) starts from the defaults, and presence and liveness are unchanged. `wakeCandidates` now skips a headless child with wake off, and one that declared `waiting-for-human` unless a pending message has origin `human`.
  - `@shipmates/pi`: the declaration is written through to shipmates and read back at `session_start`, so after a reload messages from other sessions are still held for the human. A blocking `human_ask` cut off by a shutdown or a host's abort (not by a stop request) leaves the session declared `waiting-for-human`, as a timeout does.

## 0.3.0

### Minor Changes

- 40ae3bf: `human_ask` now waits for the human by default, and the human may answer by replying in the asking session (spec D39).

  - `@shipmates/pi`: `human_ask` blocks unless `blocking: false` is passed (for an agent with independent work to do meanwhile). On timeout it declares the session `waiting-for-human` and tells the agent to end its turn. A recorded human turn in the asking session (a host's `shipmates:human-input` mark, or TUI typing) answers that session's open items on channel `session`: while a blocking `human_ask` waits, the reply becomes its result and is not also queued (the `input` handler returns `handled`); otherwise the items close with no duplicate answer message, and one notice names the items the reply closed. A `/` command is not an answer. New tool `human_withdraw(itemId)`. Tool description, guidelines and skill rewritten to say when to block.
  - `shipmates`: `AttentionItem.finishedAt`; `answerItem(..., {deliver: false})` closes an item without an answer message; `answerOpenItemsOf(session, text, opts)` (with an optional notice); `itemsFinishedSince(since)` for hosts that keep pushed notifications in step with the inbox; `SESSION_ANSWER_CHANNEL`. `withdrawItem` now throws for an unknown item or another session's item, and returns the item. `answerItem` now checks the item is open inside its write, so two channels answering at once cannot both win.

## 0.2.0

### Minor Changes

- 9e79cd2: Renamed from `kenning` to `shipmates` (spec D38). This package was published as `kenning` up to 0.1.1; it continues here, and `kenning` is deprecated. What users must change: install `shipmates` instead of `kenning` (`npm i -g shipmates`; the CLI is now `shipmates`), import from `shipmates`, and rename the environment variable `KENNING_STATE_DIR` to `SHIPMATES_STATE_DIR` (the other `KENNING_*` variables are read by the extension, see `@shipmates/pi`). The state now lives in `$XDG_STATE_HOME/shipmates/shipmates.db` (was `$XDG_STATE_HOME/kenning/kenning.db`), and nothing reads the old path: to keep existing data, stop every session, move `$XDG_STATE_HOME/kenning/` to `$XDG_STATE_HOME/shipmates/`, and rename `kenning.db`, `kenning.db-wal` and `kenning.db-shm` in it to `shipmates.db`, `shipmates.db-wal` and `shipmates.db-shm`. For hosts: the exported names are `Shipmates`, `openShipmates`, `ShipmatesError`, `ShipmatesHost` and `ShipmatesOptions` (were `Kenning...`), the host registry key is `Symbol.for('shipmates.host')` (was `kenning.host`), and the human-input events are `shipmates:human-input` and `shipmates:human-input-end` (were `kenning:...`).

## 0.1.1

### Patch Changes

- 2cb0c5b: A session that declared `waiting-for-human` now wakes when the human answers it. Before, an answer given from the inbox (`kenning answer`, or a host's inbox such as wherever's web and Telegram) was held like any other message until the human also typed into that session, so a session that asked a non-blocking `human_ask` and then waited, as the guidelines say, never saw the answer by itself. Messages from other sessions are still held for the human's next turn, and nothing wakes a session while the human is typing into it or with `/kenning wake off` (spec D37).

## 0.1.0

### Minor Changes

- 377783a: First milestone: presence and roles, messages with provenance (human, agent, human-relayed), questions with answers and waiting, the human's attention inbox, supersede and withdraw, retention, and the `kenning` CLI; the pi extension delivers at pi's boundary hooks (before settling, at turn end, waking idle sessions, holding for the human's next turn).
- 2ac04de: Spawn, stop and ownership. The core records who spawned which session (a new migration; ownership is set once, outlives presence, is transitive, and is kept while the session's transcript exists), marks archive and delete cascades as one batch undoable for 7 days, and records stop requests. `registerHost` / `currentHost` give each process one host registry on `globalThis[Symbol.for('kenning.host')]`, shared across copies of the module; `KenningHost.spawn` resolves `{sessionFile}` as soon as the session exists, and `stop(sessionFile, {by})` stops only its current turn. The CLI adds `kenning owned <target>` and `kenning stop <target>` (the human at a terminal only). The pi extension adds `session_spawn` (through the registered host, else a zellij pane or a detached headless `pi -p` woken later by its owner; optional worktree under `~/dev/worktrees/<repo>/<branch>` and fork) and `session_stop` (refused unless the caller owns the target). A spawned session's first prompt arrives as a `spawn` message from its owner, origin agent. `session_list`, `session_read` and `/kenning` show owners and owned sessions. An aborted run (a stop, or Esc) is no longer continued or re-woken by messages that were already pending.

### Patch Changes

- 2ac04de: A host's `kenning:human-input` mark is now valid for 5 s after it is emitted and is then dropped, never matched. Before, a mark whose send never reached kenning-pi's `input` handler (another extension handled the input, or a terminal pi refused the send while compacting) stayed queued, and a later identical `extension`-sourced input in that session, such as a scheduled job's prompt, was recorded as a human turn and could be relayed as `human-relayed`. A host that awaits its send can now close its mark at once with `kenning:human-input-end` `{text, id?}` (exported as `HUMAN_INPUT_END_EVENT` from `kenning`; marks may carry an `id`); the 5 s expiry stays as the backstop for fire-and-forget sends. Also, a `pi -p` prompt (which pi reports as source `interactive`) is a human turn only at a terminal outside an agent session.
