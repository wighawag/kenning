---
'kenning': patch
'kenning-pi': patch
---

A host's `kenning:human-input` mark is now valid for 5 s after it is emitted and is then dropped, never matched. Before, a mark whose send never reached kenning-pi's `input` handler (another extension handled the input, or a terminal pi refused the send while compacting) stayed queued, and a later identical `extension`-sourced input in that session, such as a scheduled job's prompt, was recorded as a human turn and could be relayed as `human-relayed`. A host that awaits its send can now close its mark at once with `kenning:human-input-end` `{text, id?}` (exported as `HUMAN_INPUT_END_EVENT` from `kenning`; marks may carry an `id`); the 5 s expiry stays as the backstop for fire-and-forget sends. Also, a `pi -p` prompt (which pi reports as source `interactive`) is a human turn only at a terminal outside an agent session.
