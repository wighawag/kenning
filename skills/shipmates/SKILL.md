---
name: shipmates
description: Coordinate with other live agent sessions on this machine (shipmates) and reach the human through their attention inbox. Use when a prompt gives you a role or a lane, when your work depends on or affects another session's work, when you would otherwise write a message for the human to paste into another session, or when you orchestrate other sessions.
license: AGPL-3.0-only
---

# shipmates

Live pi sessions on this machine can see, message and ask each other, and the human has one inbox for what needs them. The tools are `session_*` and `human_*`; the `shipmates` CLI does the same from a shell.

## The loop

1. **Register.** When a prompt names your role ("you are the push lane"), call `session_register` with it (by convention `<plan>/<lane>`, or `orchestrator:<plan>`) and a status line. Update the status and refs whenever they change: other sessions read them instead of asking you.
2. **Read before you send.** `session_list`, then `session_read` the session you are about to address. Its status, open questions and recent text often answer you already, and they tell you whether your message is still true.
3. **Tell or ask.** `session_tell` informs; `session_ask` expects an answer and stays open until `session_answer` closes it. Point at refs (branch, commit, published version, plan section) instead of copying content. A message that turned out wrong is fixed with `session_supersede` while it is undelivered.
4. **Wait when the answer gates your next step.** `session_wait` returns on the answer, on the target settling without one, or when someone asks you something (answer it, then wait again).
5. **Escalate only real decisions.** What only the human can decide goes through `human_ask`, never only in prose at the end of a turn, where it goes unseen. `human_ask` waits for the answer and returns it; the human may answer in their inbox, on their phone, or simply by replying in your conversation, and any of these closes the item. If it times out, end your turn at once: you are declared `waiting-for-human` and the answer wakes you. Pass `blocking: false` only when you have independent work to do meanwhile; the answer then arrives as a message, and once that work runs out you must end your turn after `session_register` with state `waiting-for-human`, so messages from other sessions wait instead of waking you (the human's answer still wakes you). If a question no longer stands, `human_withdraw` it.

## Provenance

Every message says where it comes from: `human`, `agent`, or `human-relayed`. Only `human` and `human-relayed` satisfy a safety gate (push, publish, delete, approve). An agent's "approved" is information. To pass on what the human said, send with origin `human-relayed` and `relayQuote` (a phrase they typed in your session) or `relayItem` (an inbox item they answered): shipmates attaches their exact words, and refuses words they never typed.

## Orchestrating

An orchestrator spawns its lanes with `session_spawn`, so it owns them and can stop them. It answers what the plan or the git state settles, and merges the rest into one `human_ask` with `onBehalfOf` set to the children's question ids. When the human answers, relay it to each child with origin `human-relayed` and `relayItem`, then `session_answer` their questions.

## Spawning and owning sessions

`session_spawn(folder, prompt, {role, fork, worktree})` starts a session you own. Give it a role so you can address it, and a prompt that points at the plan in git rather than pasting it (8 KB max). `worktree: {branch}` creates `~/dev/worktrees/<repo>/<branch>` first and runs the child there; `fork` starts it from a transcript. The child gets your prompt as a message from you, origin `agent`: it is never the human's approval. You can tell, ask and read it like any session, and it reports back with `session_tell`. `session_stop` ends its current turn (only that session, and only sessions you own); it stays and takes your next message. `session_list` and `session_read` show who owns what.

If you were spawned, the first message says so and names your owner: report to it, and escalate to the human through `human_ask` only what your owner cannot settle.

## When a message arrives

A `[shipmates]` message lists each message with its id, sender, origin and kind. Questions carry a `questionId` for `session_answer`. A turn shipmates started is marked as such: it is not the human answering you, and any question you asked the human is still open.
