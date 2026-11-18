# Store everything in one node:sqlite database in WAL mode, with forward migrations

**Status:** accepted (2026-11-17)

Several pi processes, the `kenning` CLI and wherever write one database at the same time. We use `node:sqlite` (`DatabaseSync`, built into Node >= 22.5, so no native addon has to match pi's Node, pnpm's `allowBuilds` or a Nix build), with `journal_mode=WAL` (readers never block the writer), `synchronous=NORMAL` (durable against a process crash; only a power loss can drop the last commits), `busy_timeout=5000`, and every write inside `BEGIN IMMEDIATE` so two writers never deadlock upgrading a read lock (the one case `busy_timeout` does not cover). The file is `$XDG_STATE_HOME/kenning/kenning.db` (default `~/.local/state/kenning/`), overridden by `KENNING_STATE_DIR`.

Liveness is not a heartbeat: a presence row records the pid, the process start time and the boot id, and it is live exactly when that pid still runs with that start time on this boot (the rule wherever's assistant lock uses). A crashed process therefore stops being live at once, with no timer.

Unlike memonaut's index, this database is not a derived cache: a pending message or an unanswered question exists nowhere else. So the schema has numbered forward migrations recorded in `meta`, and is never dropped and rebuilt.

**Rejected:** `better-sqlite3` (a native build to keep in step with every Node that runs pi), a daemon owning the database (one more process to leak), JSON files (no atomic multi-row update).

**Consequences:** every call is synchronous and must stay small (milliseconds). A bun-compiled standalone pi would lack `node:sqlite`, as it would for memonaut.
