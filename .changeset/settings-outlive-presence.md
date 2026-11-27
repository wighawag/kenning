---
'shipmates': minor
'@shipmates/pi': minor
---

`/shipmates wake off` and a declared `waiting-for-human` now survive a session being unloaded and loaded again (wherever's pool, a server restart, `pi --resume`) (spec D40).

- `shipmates`: migration 3 adds the `session_setting` table, kept per transcript file and pruned only once the transcript is gone. `update(file, {wake})` writes it; new `update(file, {declaredWaiting})`; `Presence.declaredWaiting`; new reads `settings()` and `setting(file)` (type `SessionSetting`) for a host showing sessions with no live presence; `register` restores `waiting-for-human` for a session that declared it and has not run since. A fork (a new file) starts from the defaults, and presence and liveness are unchanged. `wakeCandidates` now skips a headless child with wake off, and one that declared `waiting-for-human` unless a pending message has origin `human`.
- `@shipmates/pi`: the declaration is written through to shipmates and read back at `session_start`, so after a reload messages from other sessions are still held for the human. A blocking `human_ask` cut off by a shutdown or a host's abort (not by a stop request) leaves the session declared `waiting-for-human`, as a timeout does.
