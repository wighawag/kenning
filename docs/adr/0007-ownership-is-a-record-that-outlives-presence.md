# Ownership is a record that outlives presence; archive cascades as an undoable marker, stop never cascades

**Status:** accepted (2026-11-18)

An orchestrator's view of its children comes from ownership, and most of the time a child is not live: a headless `pi -p` child exits after each run, a lane may be closed for days. So ownership cannot be a field of presence, which is deleted when the process exits and pruned a day later. It is its own table (`ownership`, migration 2): a spawn is recorded before the new session exists (owner, folder, role, how it was spawned, the first prompt), then bound once to the new session's transcript path. The owner never changes; a second owner for a bound session, and a cycle, are refused. It is kept while the session's transcript exists: a record goes only when its file is gone, nobody runs it, and it is over 30 days old (D25).

Ownership is transitive. An orchestrator that spawned a lane which spawned helpers answers for all of them, so `owns(caller, target)` walks the owner chain, `ownedBy(owner, {transitive})` lists the subtree, and `session_stop` accepts any session in it.

The spec's cascade ("archiving or deleting an owner cascades to its owned sessions, with an undo window") needs transcripts deleted, which only a host can do. kenning gives the host the two things it cannot compute alone: the owned set, and a marker. `archive(session, {kind, by})` marks the session and its whole subtree as one batch; the host hides or deletes them; `undoArchive(batch)` restores the batch for 7 days; `expiredArchives()` says what may now become permanent, and a host must not remove a deleted transcript before then (D24). A headless child that is archived is never woken.

Stopping is different on purpose: it ends the current turn of the named session and nothing else, and the session stays alive (D30). A stopped run is neither continued by kenning's boundary hooks nor woken by messages that were already pending, so the stop is not undone the moment it lands.

**Rejected:** ownership in presence (gone with the process), direct-only ownership (an orchestrator could not stop its child's helpers), ownership hand-over (the spec says it never changes), kenning deleting files, a seconds-long undo (a cascade from an orchestrator takes every lane and is noticed later), and stop cascading.

**Consequences:** a fourth thing that lives only in this database (with pending messages, open questions and items): the migration is append-only like the others. A host that spawns sessions by its own means calls `recordOwnership`, or kenning never learns of the relation.
