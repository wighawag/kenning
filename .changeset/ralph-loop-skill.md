---
"kenning-pi": minor
---

New skill `ralph-loop`, typed by the human (`/skill:ralph-loop` with a brief): the session becomes the orchestrator of a Ralph loop over a plan in git. It spawns one fresh worker session per step (each runs the same step prompt from the plan), has each step reviewed by a read-only reviewer session with a bounded number of fix rounds, and gates the pushes by the approval policy in the brief: `always`, `when-unsure` (the human is asked only when a step is not certain: a clean review, "Done when" met, no decision the agent took itself, only fast-forward or new-branch pushes, nothing flagged unsure), `never`, or the human's own words. Going ahead relays the human's approval sentence as `human-relayed`, so an agent never approves a push by itself; deletions, force pushes, publishing and merges always go to the human.
