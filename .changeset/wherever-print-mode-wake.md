---
'kenning-pi': patch
---

A print-mode or json-mode session wakes itself again when it runs inside wherever's server (`globalThis[Symbol.for('wherever-dev.server-process')] === true`). The rule that a `pi -p` run never wakes itself had stopped all delivery to idle wherever server sessions, which run in print mode but are long-lived, and sessions spawned through wherever's host never started. A real `pi -p`, where the marker is absent, still never wakes itself. Also, inside wherever an input with source `interactive` is no longer taken for the human at a terminal, even when the server's stdin is a TTY; a host's `kenning:human-input` mark is the only human act there (D36).
