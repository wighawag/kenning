# A session is its transcript path; a role moves only when its holder is not live

**Status:** accepted (2026-11-17)

A session is addressed by its absolute transcript path (the key wherever and memonaut already use), with its session id stored beside it. One pi process can change sessions (`/new`, `/resume`, `/fork`), so presence is re-registered on every `session_start`. Runs without a transcript (`--no-session`) are not registered, and neither are pi-subagents children (`PI_SUBAGENT_CHILD=1`) in the first milestone: 12 of them started within one second on 2026-11-16.

A role points at whichever session does a job. A claim on a role whose holder is not live succeeds (a fresh session from the same prompt takes over the address); a claim on a live holder's role is refused unless it says `takeover`, and the old holder is told. The role is also recorded in the transcript, so a resume re-claims it, while a fork (which copies the entry into a new path) does not. Messages addressed to a role resolve when they are delivered, so a successor receives the backlog.

**Rejected:** newest-always-wins (a fork silently steals a live lane's address) and always-refuse (blocks the restart case the spec wants).
