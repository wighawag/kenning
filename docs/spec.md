# kenning: sessions that know about each other

Status: ACCEPTED (2026-11-17). Decisions below; first milestone in progress.

## The problem

Work is done by agent sessions (pi conversations) that each run in a folder: a session started from a pasted prompt, a subagent, a dorfl agent. They cannot see or address each other. When work spans several sessions, the human becomes the mail carrier: one session drafts a message, the human pastes it into another, carries the answer back, and checks by hand whether the message is still true.

The reference case is the 2026-11-17 template-tree plan (jolly-roger `docs/plans/template-tree-features.md`, "Parallel lanes"): four lanes (tree, push, triggers, messaging), each its own session in its own repo. The push lane became an orchestrator nobody appointed. It wrote "From the push lane (S1): ..." messages for the human to paste. Its first messages were wrong because it had not read the other lanes; it then found them with memonaut (`recall_sql` by project and date, `recall_thread`) and rewrote them. It is one flow among many, not the only shape to support, but it shows every need below.

## The goal

Sessions talk to each other directly. The human hears only what actually needs them, once, in context, wherever they are. An orchestrator is any session that manages others; it answers what it can and escalates the rest.

## Concepts

- **Session**: one conversation, addressed by its transcript path (the key wherever and memonaut already use).
- **Role**: an optional stable name a session declares, such as `push-lane` or `orchestrator:template-tree`. A role points to whichever session currently does that job, so a fresh session started from the same prompt takes over the address.
- **Presence**: what a live session says about itself: folder, branch, role, state (`running`, `waiting-for-human`, `waiting-for-session`, `idle`), what it is waiting on, a one-line status, its latest output refs (commits, versions).
- **Message**: from a session to a session or role. It carries a `requestId` (exactly-once delivery across retries), a delivery state (`pending`, `delivered`, `superseded`, `withdrawn`), and its provenance.
- **Question**: a message that expects an answer. It stays open until it is answered or withdrawn, and the asker can wait on it.
- **Attention item**: a question addressed to the human. It goes into one attention inbox, not into whichever conversation the human is in.
- **Owner**: the session that spawned another. Ownership is set at spawn and never changes.

## Provenance (the rule everything else depends on)

Every message and answer records its origin: `human`, `agent`, or `human-relayed` (a human's words carried by an agent, with a reference to the original attention item or turn). A session's safety gates (ask before pushing, deleting, publishing, approving) are satisfied only by `human` or `human-relayed` input that traces back to a real human act. An agent can carry a human's "I approve" to another session; it cannot produce one, and the receiver can tell the difference. Hosts show the origin on every delivered message.

## Operations

Exposed as pi tools by the extension, and as a CLI (`kenning ...`) for scripts, dorfl and humans.

- `session_register({role?, status?, refs?, state?, takeover?})`: declare this session's role and presence (D8, D9).
- `session_list`: presence of live sessions, filterable by folder, role, state. Past sessions stay memonaut's job.
- `session_read(target)`: the target's presence, its open questions, and the tail of its transcript (or a summary).
- `session_tell(target, text)`: send a message. The tool returns the target's current presence and open questions alongside the result, so the sender sees what it is talking to (read before send).
- `session_ask(target, question)` and `session_wait(target | questionId)`: ask, then block until answered or until the target finishes its turn, with a timeout.
- `session_answer(questionId, text, { relayOf? })`: answer a question; the only way to close one (D12).
- `session_supersede(messageId, text)` and `session_withdraw(messageId)`: replace or cancel a message that is not delivered yet.
- `human_ask(question, options?, blocking?)`: raise an attention item. An orchestrator raises items on a child's behalf, and may merge several children's questions into one item, keeping the link to each.
- `human_answers()`: the answers to this session's items (also delivered as messages).
- `session_spawn(folder, prompt, { role?, fork?, worktree? })`: start a session owned by the caller. `fork` starts from an existing session's transcript at a point; `worktree` creates one under `~/dev/worktrees/<repo>/<branch>` first.
- `session_stop(target)`: stop the current turn of a session the caller owns.

Delivery depends on the recipient's state: to a `waiting-for-human` session, a message is attached to the next human turn (what happens today by hand); to an `idle` session, it starts a turn; to a `running` session, it is queued for the end of the turn, or steers it if marked urgent.

## Ownership

Archiving or deleting an owner cascades to its owned sessions (with an undo window); stopping affects only the session named. An orchestrator's view of its children comes from ownership.

## The shared ground stays in git

kenning carries short messages, questions and status. Content stays where it already lives: plans and contracts in a git branch, code in commits, packages on npm. Messages point at those (a ref, a version, a section) instead of copying them.

## Architecture

- **Core** (library): identity, presence, mailbox, questions, attention inbox, ownership, in SQLite under `$XDG_STATE_HOME/kenning/`. Single machine. Safe for concurrent writers (several pi processes).
- **pi extension**: the tools above, presence heartbeats from the session's lifecycle, and inbox delivery for a plain pi process (watch the mailbox, inject at the right moment).
- **CLI**: the same operations, plus `kenning inbox` for a terminal-only human.
- **Host interface**: how a host delivers, spawns and stops. The extension provides the default for a terminal pi (spawn as headless `pi -p` or a zellij pane).
- **wherever** (first-class host, in its own repo): delivers through its session pool instead of polling, turns spawns into sidebar sessions under their owner, shows presence, and renders the attention inbox (a panel, a badge, a reply box that routes the answer back) using its existing push and Telegram channels for blocking items. wherever's assistant can read the inbox but is not the inbox.

## Compared with bb (getbb.app)

bb's thread spawn, fork, tell, queue, log, wait, list, stop, lifecycle ownership, manager threads, interactions and managed worktrees all have an equivalent above. Not taken: remote hosts, terminals, browser, files over the CLI, plugins, the IDE (pi tools, webhands and wherever cover these). Added beyond bb: the provenance rule, the attention inbox with orchestrator escalation, git as the shared ground, and working across independent pi processes rather than inside one app.

## Out of scope for now

- Several machines (shyrka). Later, through wherever, which is already reachable remotely.
- Pi Durable. Its ideas are taken (exactly-once `requestId`, a subagent as a real conversation, ownership); a migration is a later question.
- Automatic orchestration policies (when an orchestrator answers versus escalates). The first version gives the primitives; the policy lives in the orchestrator's prompt.

## Open questions

All five were settled on 2026-11-17: summaries in D14, role collisions in D9, delivery while waiting for the human in D3, retention in D11, subagents in D7.

## First milestone

The core, the pi extension and a minimal CLI, working between terminal pi sessions, and loading without harm inside wherever (where agent-to-agent messages already work through the generic extension). The wherever host side (inbox panel, push and Telegram, human-turn marking, spawn as sidebar sessions) is the second milestone, in the wherever repo.

Scope: core (store, migrations, presence and liveness, roles, mailbox with supersede and withdraw, questions, attention items, retention, host-interface types); extension tools `session_register`, `session_list`, `session_read`, `session_tell` (with `urgent`), `session_ask`, `session_answer`, `session_wait`, `session_supersede`, `session_withdraw`, `human_ask`, `human_answers`; the `/kenning` command (status, inbox, deliver, wake); CLI `kenning list | read | tell | ask | inbox | answer`. Out: spawn, stop, ownership cascade, wherever wiring, subagents registering, generated summaries.

Done when: `pnpm format:check && pnpm build && pnpm test` is green; a scenario test with real pi processes on scripted (faux) models shows a lane telling another a correction, a question to a lane that waits for the human held and attached to the human's next turn, an idle lane woken and answering, a `human-relayed` approval with a valid `relayOf` accepted, an agent-origin "approval" unable to pass for human, a superseded message never delivered, and no process left behind; and a manual checklist for two real terminal sessions is in the README.

## Decisions

Taken on 2026-11-17 after reading pi 1.4.0's extension API (`docs/extensions.md`, `dist/core/extensions/types.d.ts`, `dist/core/agent-session.js`), memonaut, wherever's `CONTEXT.md` and the 2026-11-17 lane transcripts. Each names the alternative rejected. The ones costly to reverse also have an ADR in `docs/adr/`.

- **D1. The first milestone does not include the wherever host side.** It must load harmlessly in wherever and work agent-to-agent there; the inbox UI and human-turn marking are wherever's own milestone. Rejected: keeping "in wherever" in milestone 1, which needs wherever changes first. The done-when is an automated scenario plus a manual checklist, not a field trial.
- **D2. Provenance is integrity against confused agents, not against a malicious one on the same Unix user** (ADR 0003). kenning never lets an agent produce human-origin input through kenning; forging one means bypassing kenning (writing its database, faking a terminal), which the safety rules forbid. Human acts are: TUI typing (`input` source `interactive`), a kenning slash command (the model cannot invoke one), the CLI only with a TTY and without `PI_SESSION_FILE`, and a host's explicit mark. `human-relayed` requires `relayOf` naming a recorded human turn, and carries the human's verbatim words. A signature field is reserved for a host running as another user. Rejected: claiming the strong guarantee, which is false on one user.
- **D3. Delivery never uses pi's in-memory queues** (ADR 0002). Running: at `agent_before_settle` (entries plus `continue`), or at `turn_end` when urgent. Idle: `sendMessage(..., {triggerTurn: true})`. Waiting for the human: held, shown in a widget and a footer badge, and attached to the human's next run by `before_agent_start`; `/kenning deliver` delivers now. Blocked in `session_wait`: its result. Not live: pending until resume or role takeover. Rejected: `deliverAs` steer, followUp or nextTurn (cannot be withdrawn or superseded, lost on crash) and the `input` transform (mixes agent words into the human's).
- **D4. `waiting-for-human` is declared, not inferred** (ADR 0006): an open blocking `human_ask`, an open `ctx.ui` dialog, or the agent's own `session_register` state. Otherwise a settled session is idle and messages wake it, except while the TUI editor holds text (the human is typing) or `/kenning wake off`. The extension's guidelines tell the agent to raise human decisions with `human_ask`. Rejected: treating every human-started session as waiting (nothing would ever wake) and guessing from the last text.
- **D5. Exactly-once delivery.** `requestId` is unique per sender (default: derived from the tool call id); a message is claimed by one live process with a lease, marked delivered when it is in the receiver's transcript, and reconciled from the transcript at `session_start`. Rejected: marking delivered at hand-off, which loses messages on crash.
- **D6. One poller per process** on `PRAGMA data_version`, every 1 s, `unref`'d, started on `session_start` and stopped on the last `session_shutdown`. Rejected: no watcher (idle sessions could never wake) and `fs.watch` alone (unreliable across platforms and checkpoints).
- **D7. Identity and who registers** (ADR 0004). A session is its absolute transcript path, with its session id stored beside it; `/new`, `/resume` and `/fork` re-register. `--no-session` runs stay out. Subagent children (`PI_SUBAGENT_CHILD=1`) stay dormant in milestone 1; registering them as owned children (`PI_SUBAGENT_PARENT_SESSION`) is the later step. `pi -p` runs register while they run. Inside wherever (its `wherever-dev.server-process` marker) kenning behaves as a headless host. Rejected: registering every process, which floods the list (12 subagents in one second on 2026-11-16).
- **D8. Roles are declared** with the `session_register` tool, the `--kenning-role` flag or `KENNING_ROLE`, as `[a-z0-9._:/-]` strings, by convention `<plan>/<lane>` or `orchestrator:<plan>`. The role is also written to the transcript so a resume re-claims it. Folder and branch are filled in automatically; status and refs are what the agent declares. Rejected: inferring the role from the prompt.
- **D9. Role collisions: the newest claim wins only if the holder is not live**; a live holder keeps it unless the claim says `takeover`, and the old holder is told. A fork inherits the role entry but not the role. Messages addressed to a role resolve at delivery, so a successor gets the backlog. Rejected: refusing always (blocks the restart case) and newest-always-wins (a fork steals a live lane's address).
- **D10. Storage** (ADR 0001): `node:sqlite`, WAL, `synchronous=NORMAL`, `busy_timeout=5000`, every write in `BEGIN IMMEDIATE`, at `$XDG_STATE_HOME/kenning/kenning.db` (`KENNING_STATE_DIR` overrides). Liveness is a pid with the same process start time and boot id, so a crash needs no heartbeat to be detected. The schema has forward migrations: unlike memonaut's index, this database is not a derived cache. Rejected: `better-sqlite3` (native build), a daemon, JSON files.
- **D11. Retention.** Pending messages and open questions are never pruned by age (a message to a role unheld for 7 days shows as undeliverable); finished messages, questions and items are deleted after 30 days; dead presence after 1 day; pruning runs on open, at most daily. Rejected: keeping everything.
- **D12. Questions.** `session_answer(questionId, text)` is added (the spec had no way to close a question). `session_wait` returns on the answer, the target settling without answering, an incoming question to the waiter (to break A-waits-on-B-asks-A deadlocks), timeout (default 15 min, max 2 h) or abort. Rejected: answers as plain tells.
- **D13. The human's inbox in milestone 1** is a footer badge in every live TUI session, `/kenning inbox` (answers typed in a slash command are human), and `kenning inbox` / `kenning answer` on the CLI. A blocking `human_ask` also opens a dialog in its own TUI. `human_ask` takes `onBehalfOf` question ids so an orchestrator can merge children's questions and relay the answer as `human-relayed`. Rejected: injecting items into the current conversation.
- **D14. `session_read`** returns presence (with the session's own status line, the best summary there is), open questions, and the last 6 user and assistant texts (2 KB each, 12 KB total), read backwards from the file end; deeper history is `recall_thread`. Message text is capped at 8 KB to push content into git refs. Rejected: a generated summary on every read (cost, latency, nondeterminism); it may come later as an opt-in paid by the reader.
- **D15. Targets.** A string ending in `.jsonl` is a path; otherwise an exact role, then a unique session-id prefix; ambiguity is an error listing candidates. Rejected: an `@role` sigil.
- **D16. Packages** (ADR 0005): a pnpm monorepo like memonaut, with `kenning` (core and CLI, no runtime dependencies) and `kenning-pi` (extension and skill, `pi install npm:kenning-pi`). Rejected: one package (peer-dependency noise for every non-pi importer) and an `@kenning` scope (not owned).
- **D17. License: AGPL-3.0-only**, like memonaut, wherever and the lanes' repos. Rejected for now: MIT or MPL-2.0, worth revisiting before outside contributions if pi upstream or other harnesses should adopt kenning.
- **D18. Tooling** follows memonaut; the pi dev dependency is `~1.4.0` (the installed pi, and wherever's tested range), not memonaut's stale `^0.80.3`.
- **D19. Spawn outside wherever** (not in milestone 1): a zellij pane when `$ZELLIJ` is set, otherwise a detached headless `pi -p` in its own process group, woken later by `pi --session <path> -p`, with `--session-id` assigned up front. Rejected: an RPC supervisor daemon.
- **D20. The host interface** is exported by the core with the terminal default in the extension: `deliver`, `humanTurn`, optional `notifyHuman`, `spawn`, `stop`, and a change feed. wherever implements it in its own milestone.
- **D21. Tests**: core through its public interface on a temporary state dir; a multi-process writer test; a pure delivery planner; and real `pi --mode rpc` processes on pi-ai's faux provider, each in its own process group, killed by group, with a final check that no test pid survives.
- **D22. Hosts mark human input on the session's event bus.** Before sending a human's text, a host emits `kenning:human-input` `{text, channel}` on `pi.events` (one bus per session, unreachable by the model); kenning's `input` handler records the next matching `extension`-sourced input as a human turn. Rejected for now: asking pi upstream to carry an origin on `prompt()`/`sendUserMessage` and persist it on the user entry, which is the better long-term home and should be proposed.
