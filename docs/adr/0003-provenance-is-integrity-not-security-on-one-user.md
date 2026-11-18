# Provenance protects against confused agents, not against a malicious one on the same Unix user

**Status:** accepted (2026-11-17)

Every message records `human`, `agent` or `human-relayed`, and safety gates accept only the first and the last. On one Unix user an agent's `bash` can write kenning's database or run its CLI, so kenning cannot make human origin unforgeable. What it guarantees is that no kenning tool lets an agent claim it, and that forging it means deliberately bypassing kenning.

Human acts are recognised only from channels an agent cannot reach through kenning: typing in the TUI (`input` with `source: "interactive"`), a kenning slash command (the model cannot invoke slash commands), the CLI only with a TTY and without `PI_SESSION_FILE` (pi sets it in the bash tool's environment), and a host's explicit mark: before sending a human's text, a host emits `kenning:human-input` `{text, channel}` on the session's `pi.events` bus, which only extension code can reach, and kenning records the next matching input as a human turn. `human-relayed` must name such a turn (`relayOf`), and the receiver gets the human's verbatim words with it, not the agent's paraphrase.

**Rejected:** claiming the strong guarantee (false on one user). Reserved for later: a signature by a host that runs as another user (wherever as a NixOS system service), and an upstream pi change that carries an origin on `prompt()` / `sendUserMessage` and stores it on the user entry.
