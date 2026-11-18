# Deliver at pi's boundary hooks, never through pi's in-memory queues

**Status:** accepted (2026-11-17)

pi can queue a message into a running session (`deliverAs: "steer" | "followUp" | "nextTurn"`), but once queued it can never be withdrawn or superseded (the extension API has no way to remove a queued message), and it lives only in memory, so a crash loses it. kenning needs supersede and withdraw (the 2026-11-17 push lane rewrote its first, wrong messages), and exactly-once delivery.

So a message stays in kenning until the last moment and is decided then:

- running: returned as `custom_message` entries from `agent_before_settle` with `continue: true` (the agent reads it before it stops), or from `turn_end` when marked urgent;
- idle: `pi.sendMessage(..., {triggerTurn: true})`;
- waiting for the human: held, shown in a widget and a footer badge, and returned as the `message` of `before_agent_start` when the human next starts a run;
- not live: left pending until the session resumes or its role is taken over.

A message is marked delivered when its custom message is in the receiver's transcript, and `session_start` reconciles from the transcript, so a crash between injection and marking never duplicates it.

**Rejected:** pi's queues (no withdraw, lost on crash) and the `input` transform (it would merge an agent's words into the human's, breaking provenance).
