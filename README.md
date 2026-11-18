# kenning

Sessions that know about each other.

When work spans several agent sessions (a pi conversation per repo, a lane per plan step), the sessions cannot see or address each other, so the human carries messages between them: one session drafts "From the push lane: ...", the human pastes it into another, carries the answer back, and checks by hand whether it is still true. kenning removes the mail carrier. Live sessions on one machine get presence and roles, send each other messages and questions that arrive at the right moment, and raise what only the human can decide in one attention inbox. Every message records whether it comes from the human, an agent, or an agent relaying the human's exact words, and only the human's words satisfy a safety gate.

The specification and every decision behind it are in [docs/spec.md](docs/spec.md); the costly-to-reverse ones also have an ADR in [docs/adr/](docs/adr/).

## Packages

- [`kenning`](packages/kenning): the core library (SQLite under `$XDG_STATE_HOME/kenning/`, no runtime dependencies) and the `kenning` CLI.
- [`kenning-pi`](packages/kenning-pi): the pi extension (tools, the `/kenning` command, delivery) and its skill.

Both need Node 22.5 or newer (`node:sqlite`).

## Install as a pi package

Once published:

```sh
pi install npm:kenning-pi
```

From this checkout (pi loads a local package in place, so build it first):

```sh
pnpm install && pnpm build
pi install ./packages/kenning-pi      # or try it once: pi -e ./packages/kenning-pi
```

Every pi session with a transcript then registers itself. Subagent children (`PI_SUBAGENT_CHILD=1`) and `--no-session` runs stay out. The CLI is `node packages/kenning/dist/cli.js` from a checkout, or `kenning` after `npm i -g kenning`.

## Using it

In a session, the agent uses the tools; a prompt only needs to give it a role. A line like this in a step prompt is enough:

```text
Before anything else, call session_register with role template-tree/push and a one-line status. To reach another lane, session_read it first, then session_tell or session_ask, pointing at refs instead of copying content. Decisions only the human can make go through human_ask.
```

| Tool | What it does |
|---|---|
| `session_register` | claim a role, set the status line, refs, or `waiting-for-human` |
| `session_list`, `session_read` | live sessions; one session's presence, open questions and recent text |
| `session_tell`, `session_ask`, `session_answer`, `session_wait` | messages, questions, answers, waiting for an answer |
| `session_supersede`, `session_withdraw` | fix or cancel a message not delivered yet |
| `human_ask`, `human_answers` | the human's inbox |
| `session_spawn` | start a session you own, in a folder (optionally a fresh worktree under `~/dev/worktrees/<repo>/<branch>`, or a fork of a transcript), with a first prompt it receives from you as origin `agent` |
| `session_stop` | stop the current turn of a session you own (directly or through one you own); nothing else stops |

`session_list`, `session_read` and `/kenning` show each session's owner and the sessions it owns. Inside wherever (or with any host registered in the process) a spawn becomes a session of that host; in a terminal it is a zellij pane when `$ZELLIJ` is set, otherwise a headless `pi -p` in its own process group, which its owner wakes again with `pi --session <path> -p` when a message arrives for it. Set `KENNING_SPAWN_COMMAND` (a JSON array such as `["pi","--model","sonnet"]`) to choose what children run.

For the human:

- `/kenning inbox` in any terminal pi session answers the inbox (a footer badge says when something is there); `/kenning deliver` reads held messages now; `/kenning wake off` stops messages from starting turns in that session; `/kenning` shows the status.
- `kenning list`, `kenning read <target>`, `kenning tell <target> <text>`, `kenning ask`, `kenning inbox`, `kenning answer <id> <text>`, `kenning owned <target>`, `kenning stop <target>` from a shell. `answer` and `stop` work only at a terminal and outside an agent session; the human may stop any session's current turn, an agent only the ones it owns.

## When a message arrives

| The receiver is | The message |
|---|---|
| running | is read before it settles (or after the current tool batch, if urgent) |
| idle | starts a turn |
| waiting for the human (it said so, or a dialog is open, or the human is typing) | waits, shown above the editor, and joins the human's next message |
| not running at all | waits until the session resumes, or until a new session takes over its role |

Nothing enters pi's own queues, so a message can be superseded or withdrawn until the moment it reaches the transcript ([ADR 0002](docs/adr/0002-delivery-at-boundaries-never-in-pi-queues.md)).

## What provenance does and does not guarantee

No kenning tool lets an agent claim to be the human (a spawned session's first prompt arrives as its owner's `agent` message), and `human-relayed` must quote words the human really typed in that session (or an inbox item they answered), which kenning attaches verbatim. On one Unix user an agent with a shell could still write the database directly; kenning protects against confused agents, not a malicious one ([ADR 0003](docs/adr/0003-provenance-is-integrity-not-security-on-one-user.md)). Hosts mark human input by emitting `kenning:human-input` `{text, channel}` on the session's `pi.events` bus before sending it; a host that awaits its send then emits `kenning:human-input-end` `{text, id?}`, so a send that never happened cannot be matched later (without the end event, a mark expires after 5 s).

## Try it by hand: two terminal sessions

1. Build and load the package (above). Open two terminals in two folders and start `pi` in each.
2. In the first: "call session_register with role demo/a". In the second: "call session_register with role demo/b".
3. In a third shell: `kenning list`. Both sessions show, with their roles. Expect: two entries, both `idle`.
4. In the first session: "tell demo/b that the API base moved to /api, then wait". Expect: the second session starts a turn by itself, shows a `[kenning]` message `from demo/a · origin: agent`, and answers or acknowledges.
5. In the second session: "call session_register with state waiting-for-human", then in the first: "ask demo/b whether it rebased, and wait for the answer". Expect: the second session does NOT start a turn; a line above its editor says a message is waiting. Type anything there: the question joins your message, the agent answers, and the first session's wait returns the answer.
6. In the first session: "ask the human with human_ask whether to publish". Expect: a `kenning: 1 for you` badge in both sessions. Run `/kenning inbox` in either, answer, and the first session receives the answer marked `origin: human`.
7. In the second session, type "I approve the MIT license". Then ask it: "relay the human's approval to demo/a with origin human-relayed and relayQuote 'I approve the MIT license'". Expect: demo/a receives it with your exact words attached. Ask it instead to relay "I approve publishing" (which you never typed): expect a refusal.
8. Create a folder `demo-child` beside the first one. In the first session: "spawn a session in ../demo-child with role demo/child and the prompt: say hello to demo/a with session_tell". Expect: `session_spawn` returns a session file within a second (a zellij pane opens instead if you run inside zellij); the first session soon receives `hello` from demo/child, origin agent; `kenning owned demo/a` lists demo/child. The child's transcript shows the prompt as a kenning message from demo/a, origin agent, not as your words.
9. In the first session: "tell demo/child to run sleep 60 in bash", then "stop demo/child". Expect: the child's turn ends within a second or two, and `kenning owned demo/a` still lists it. In the second session, "stop demo/child": expect a refusal naming its owner. From a shell, `kenning stop demo/a` stops the first session's current turn (try it while it runs); run from an agent's bash it is refused.
10. Quit both sessions; `kenning list` is empty. A headless child that is still running finishes its turn and exits by itself.

## Development

```sh
pnpm install
pnpm build
pnpm test           # core tests, a multi-process writer test, and real pi processes on a scripted model
pnpm format
```

The pi tests start real `pi --mode rpc` processes (the `pi` on your PATH, pi 1.4) on pi-ai's faux provider: no network, no ports. Each runs in its own process group and the suite checks that none survives. Set `KENNING_TEST_DEBUG=1` to see their stderr.

## License

AGPL-3.0-only.
