---
title: A status line named an answered inbox item as pending, because the answer was never delivered to the running session
type: observation
status: spotted
spotted: 2026-11-28
---

# A status line named an answered inbox item as pending, because the answer was never delivered

## What was reported

On 2026-11-28 the session `template-tree/jolly-roger-descendants-cascade` had the status "... voxlings held pending human h_zzpXymEt; nothing pushed". The human had answered `h_zzpXymEt` ("Skip voxlings"). The orchestrator `conquest/ui-strategy` read the status with `session_list` / `session_read`, took it at face value, and told the human they still had a question to answer. The report assumed the cascade session had received the answer, gone on, and forgotten to update its status, and that `session_read` showing "no open questions" was the accurate signal that was ignored.

## What actually happened (measured, read-only)

Sources: the cascade transcript `~/.pi/agent/sessions/--home-wighawag-dev-github-wighawag--/2026-11-28T10-59-29-118Z_01a221cf-62de-730d-99e0-f53bbcfa3095.jsonl` (entries 103 to 197) and the shipmates database (`item`, `message`, `presence` rows), read at 12:18 UTC.

| time (UTC) | event |
| --- | --- |
| 11:19:47 | entry 103: `human_ask` with `blocking: false` raises `h_zzpXymEt` ("raised ... not blocking. Go on with your independent work; the answer arrives as a message") |
| 11:23:47 | the human answers on **telegram**: "Skip voxlings again (report it as left behind)". `item.state = answered`; answer message `m_QmSKYlin` (origin `human`, kind `answer`) created, `state = pending` |
| 11:26:11 | entry 123: `session_register` status "... (voxlings held, asked human h_zzpXymEt) ..." |
| 11:43:35 | entry 181: `session_register` status "... voxlings held pending human h_zzpXymEt; nothing pushed" |
| 11:44 to 12:18+ | the session sits in `sleep 1500` then `sleep 1700` bash calls inside the SAME agent run |
| 12:18 | `m_QmSKYlin` is still `pending`; presence `state = running`, `settled_at = null`, `waiting_on = null` |

So the premise is wrong in a way that matters:

1. **The cascade session never received the answer.** Its status at 11:43, written 20 minutes after the answer, was an honest statement of what it knew. It did not "go on and forget"; the transcript contains no delivery of `m_QmSKYlin` at all.
2. **The answer is held by design.** `planDelivery` (`packages/shipmates/src/delivery.ts`) delivers to a running session at `agent_before_settle` unless the message is `urgent` (then `turn_end`, `atTurnEnd` in `packages/shipmates-pi/src/session.ts:576`). An inbox answer is never urgent, so it waits for the end of the whole run. This run has been going for over an hour with long sleeps, and it will only see the answer when it settles. That contradicts what `human_ask` tells the agent in the non-blocking case ("Go on with your independent work; the answer arrives as a message"): it arrives only once the independent work is over, which is exactly when it is no longer useful, and it cannot change course mid-run (here: it could have reported voxlings as left behind, or stopped holding a merge for it).
3. **`session_read` showing "no open questions" was not a signal about `h_zzpXymEt`.** `session_read` and `session_tell` show `openQuestionsTo(target)` (`summary()` in `packages/shipmates-pi/src/tools.ts`): `q_...` questions other sessions asked the target. Attention items the target raised (`h_...`) are not shown anywhere in `session_list` or `session_read`, open or answered. Nor are the target's pending inbound messages. The orchestrator therefore had no way, through the tools, to see either "h_zzpXymEt is answered" or "its answer is waiting to be delivered". The empty question list would have looked identical had the item still been open.
4. **`waiting on h_...` does not cover this case.** `waitingOn` is set only by `setToolState` while a blocking `human_ask` polls (`session.ts:303`). A non-blocking item leaves `waiting_on` null, and the session is `running`, so the derived signal that exists today says nothing.

What shipmates knew and nobody displayed: `h_zzpXymEt` answered at 11:23 on telegram, and `m_QmSKYlin` pending for the target since then.

## Evaluation of the two candidate fixes

### 1. Annotate stale references in status lines

When a status names `h_...` or `q_...`, `session_list` / `session_read` (and `formatPresence` generally) append the id's actual state. Cheap (`item(id)` / `question(id)` are single-row lookups; ids are the prefix plus 8 base64url characters, so `/\b[hq]_[A-Za-z0-9_-]{8}/`, see `ids.ts`) and harmless to free text.

It must say more than "answered", or it misleads in the other direction: here the right annotation is not "(h_zzpXymEt answered 11:23)" but "(h_zzpXymEt answered 11:23 on telegram; answer not yet delivered to this session)". "Answered" alone would have led the orchestrator to assume the cascade session was acting on "skip voxlings", which it was not. The delivered/undelivered half comes from the item's answer message (`message.item_id = h_...`, its `state`), already in the store.

Verdict: worth doing, with the delivery half. It patches the symptom for any free text that happens to cite an id, and it is the only fix that helps a reader of an arbitrary status. It does nothing when the status describes the wait without the id ("waiting for the human on voxlings").

### 2. Derive the human-facing waiting state from open items

Partly done (`waiting on h_...` for a blocking ask). Extending it: presence (or `session_read`) carries the target's items, derived, not declared: open items it raised, and items answered whose answer is still pending to it. Rendered as e.g. `asked the human: h_zzpXymEt (not blocking, open)` or `h_zzpXymEt answered 11:23 (telegram), answer pending delivery`. This is the structural fix for point 3: the reader gets the truth from the store whatever the status text says, and the same data answers "does the human owe this session anything" (open items) separately from "does this session know the answer yet" (pending answers). Linting or nudging statuses that mention ids is then secondary: a nudge from `session_register` ("h_zzpXymEt is already answered; your status says pending") would NOT have fired here, because at 11:43 the session itself had not received the answer; the warning would have told it about an answer it has not been shown, which is a delivery by another route (and should then just be the delivery).

Verdict: do it. It is the fix that would have prevented the wrong message to the human, since the orchestrator would have seen no open item.

### 3. (Better, and the actual root cause) Deliver the human's answer at `turn_end`

The cascade session should have received "Skip voxlings" within one turn of 11:23, not at the end of an hours-long run. Proposal: in `planDelivery` and `atTurnEnd`, treat a pending message of origin `human` (inbox answers, the human's `shipmates tell`) like `urgent`: deliver it at the next `turn_end` with `continue`. This is the same reasoning as D37 (a session waiting for the human wakes for the human) applied to a running session: an answer the agent was explicitly told to expect "as a message" while it works should arrive while it works. It stays inside ADR 0002 (a boundary, not pi's queues). Messages of origin `agent` keep `at-settle`, so other sessions still cannot interrupt a run without `urgent`. Cost: the same as an urgent message; the human is rate-limited by being one person. Test seam: `planDelivery` (`fromHuman` while `phase: 'running'`) and a real-pi flow in `flows.test.ts` where a running session with a non-blocking item gets the answer before its run settles.

With this, the status at 11:43 would have been written after the session read the answer, and the session would most likely have written "voxlings skipped (human, h_zzpXymEt)". It does not remove the need for fix 2: a session in one long tool call (`sleep 1700`) still only sees it at that call's `turn_end`, and statuses can go stale for other reasons.

## On the skill and `session_register`

- **Skill (`skills/shipmates/SKILL.md`, "Read before you send")**: add one sentence: a status line is the session's own words and may lag; for what the human owes it, trust the derived fields (open items, `waiting on`, pending answers) over the status text, and say "answered on <channel>, not yet delivered" rather than "still pending" when they disagree. Telling readers to trust "open questions" as worded today would be wrong advice: that list is `q_` questions to the target, not its `h_` items. If fix 2 lands, the guideline points at its field; until then, the skill should at least say that `session_read` does not show a session's inbox items, so a status naming one cannot be checked there (`shipmates inbox` / the host's inbox can).
- **Writer side**: the existing guideline ("keep its status line current") is fine. Add to the non-blocking `human_ask` result and the guideline: when the answer arrives, update the status if it named the item. A `session_register` warning about a resolved id is low value for the reason above (the writer usually has not seen the answer when the status goes stale), except for an id answered AND delivered to it, which is a genuine forgotten update; that narrow warning is cheap and fine to add with fix 1's lookup.
- **Orchestrator conduct (not a shipmates defect)**: `conquest/ui-strategy` relayed "you still have a question to answer" to the human from a status line alone. The human-facing claim should have been checked against the inbox (`shipmates inbox`, or the host's) before it reached the human. Captured here because it is the behaviour fixes 1 and 2 support, and the skill sentence above would have prevented.

## Recommended order

1. Fix 3 (deliver origin-`human` answers at `turn_end`): root cause, small, spec amendment to D3/D39, planner test plus one flow.
2. Fix 2 (derived items in `session_read`/presence, including "answered, pending delivery"): structural, needs a small core query (items by `session_file` with their answer message state) and a `formatPresence` change; `session_list` may show a compact count only.
3. Fix 1 (annotate `h_`/`q_` ids in status text), reusing fix 2's lookup, with the narrow `session_register` warning.
4. Skill sentence, in the same change as 2.

## Immediate state

As of 12:18 UTC, `m_QmSKYlin` is still pending for the cascade session; it will deliver when that run settles. Stopping the run would not help: after an aborted run, mail already pending waits for a newer message (D30). No action taken here (analysis only).

## Update (2026-11-28, later)

Fixes 1 to 4 implemented as spec D41 (the human asked for them): origin-`human` messages delivered at `turn_end` to a running session; `outstandingItems` / `itemStatus` / `statusFacts` in the core, shown under every status by `session_list`, `session_read`, `session_tell`, `session_wait`, `/shipmates` and the CLI; the narrow `session_register` note; guideline and skill sentences. Tests: `packages/shipmates/test/status-facts.test.ts`, `delivery.test.ts`, and two real-pi assertions in `packages/shipmates-pi/test/flows.test.ts` (the turn-end flow fails without the planner change).
