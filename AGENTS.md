# kenning: Agent Guidelines

## Read this first

`docs/spec.md` is the specification, and its "Decisions" section (D1 to D22) records every choice with the alternative rejected; `docs/adr/` holds the costly-to-reverse ones. Do not contradict a decision without new evidence; propose a change to the spec instead.

## Invariants that must not be broken

1. **Nothing enters pi's in-memory queues** (`deliverAs` steer, followUp, nextTurn). Delivery happens at `before_agent_start`, `turn_end`, `agent_before_settle`, or `sendMessage` with `triggerTurn` for an idle session (ADR 0002). Queued messages cannot be withdrawn and are lost on crash.
2. **Delivered means "in the receiver's transcript".** A message is claimed (one process, with a lease) right before injection, and marked delivered by scanning the branch for its id (`reconcile` in `kenning-pi/src/session.ts`). Boundary entries emit no `message_end` (measured), so the scan is the only reliable signal. Always reconcile before claiming.
3. **A process never re-claims a message it is already delivering.** `claim()` skips messages under any live, unexpired lease, this process's included (measured: the opposite injected messages twice).
4. **`claim()` takes the write lock only when something is claimable.** The poller calls it every second in every process (measured: four processes claiming in a loop pushed a writer past `busy_timeout`).
5. **No kenning tool can produce origin `human`.** Human acts are TUI input (`source: "interactive"`), a slash command, the CLI at a terminal outside an agent session, or a host's `kenning:human-input` mark (ADR 0003). `human-relayed` always carries the human's verbatim words.
6. **The database is not a cache.** Schema changes are new entries appended to `MIGRATIONS` in `packages/kenning/src/store.ts`; never edit a migration that shipped, never drop and rebuild.
7. **Every write goes through `BEGIN IMMEDIATE`** (`write()` in `store.ts`); setup alone is retried on `SQLITE_BUSY`, because the first switch to WAL can refuse without calling the busy handler (measured).
8. **Never leave a process behind.** The pi tests start real `pi` processes in their own process group and assert that none survives; keep that assertion.

## Layout

- `packages/kenning`: the core (`Kenning` in `src/kenning.ts` is the one deep module), the transcript tail reader, the delivery planner, the change watcher, the host-interface types, and the CLI (`src/cli-run.ts`, testable; `src/cli.ts` is the bin). No runtime dependencies.
- `packages/kenning-pi`: the extension. `src/session.ts` is one session's presence and delivery, `src/tools.ts` the tools, `src/shared.ts` the one connection and watcher per process, `src/index.ts` only wiring. Depends on the core, never the other way round.
- `skills/kenning/SKILL.md` is the skill's only home; `kenning-pi`'s build copies it.

## Measured facts

- Poller: `changeToken()` (`PRAGMA data_version`) costs about 2 µs, so the 1 s poll is about 7 ms of CPU per hour per process. A `send` is about 0.12 ms.
- The pi suite (three to four real pi processes, ten flows) runs in about 3.5 s.

## Conventions

- Tabs, single quotes, no bracket spacing (`.prettierrc`). Run `pnpm format` before finishing.
- Comments explain why. If a line encodes a measured fact, say the number.
- Every behavioural change gets a test at a seam already in use: the `Kenning` interface, `readTail`, `planDelivery`, `runCli`, the multi-process writer, or the real-pi flows in `packages/kenning-pi/test/flows.test.ts`.
- Add a changeset (`pnpm changeset`, or `.changeset/<name>.md` by hand) for every change to a package.

## Never stage or commit unless asked

Do not run `git add`, commit, push or publish unless the user explicitly asks. Leave changes unstaged.
