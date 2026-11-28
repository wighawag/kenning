---
'shipmates': minor
'@shipmates/pi': minor
---

A status line that lags no longer passes for the truth, and the human's answer reaches a running session at the turn end (spec D41).

- `shipmates`: `planDelivery` delivers a pending message of origin `human` to a running session `at-turn-end`, as an urgent one. New reads `outstandingItems(session)` (items it raised that are open, or answered with the answer not yet delivered to it), `itemStatus(id)` (type `ItemStatus` with `answerPending`) and `statusFacts(session, status?)` (type `StatusFacts`: those items, plus each `h_`/`q_` id the status names that is no longer open, type `StatusRef`); formatters `formatStatusFacts`, `formatStatusRef`, `formatItemFact`; `Question.finishedAt`. The CLI's `list` and `read` print the facts under the status. No migration.
- `@shipmates/pi`: the human's answer (and any origin-`human` message) is delivered at the next `turn_end` of a running session instead of when its run settles, so a non-blocking `human_ask`'s answer arrives while the agent still works. `session_list`, `session_read`, `session_tell`, `session_wait` and `/shipmates` show the derived facts under each status; `session_register` notes when your own status names an item whose answer you have already read. The guidelines and the skill tell readers to trust those lines over status text.
