---
'shipmates': minor
'@shipmates/pi': minor
---

`human_ask` now waits for the human by default, and the human may answer by replying in the asking session (spec D39).

- `@shipmates/pi`: `human_ask` blocks unless `blocking: false` is passed (for an agent with independent work to do meanwhile). On timeout it declares the session `waiting-for-human` and tells the agent to end its turn. A recorded human turn in the asking session (a host's `shipmates:human-input` mark, or TUI typing) answers that session's open items on channel `session`: while a blocking `human_ask` waits, the reply becomes its result and is not also queued (the `input` handler returns `handled`); otherwise the items close with no duplicate answer message, and one notice names the items the reply closed. A `/` command is not an answer. New tool `human_withdraw(itemId)`. Tool description, guidelines and skill rewritten to say when to block.
- `shipmates`: `AttentionItem.finishedAt`; `answerItem(..., {deliver: false})` closes an item without an answer message; `answerOpenItemsOf(session, text, opts)` (with an optional notice); `itemsFinishedSince(since)` for hosts that keep pushed notifications in step with the inbox; `SESSION_ANSWER_CHANNEL`. `withdrawItem` now throws for an unknown item or another session's item, and returns the item. `answerItem` now checks the item is open inside its write, so two channels answering at once cannot both win.
