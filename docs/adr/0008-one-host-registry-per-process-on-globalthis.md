# One host registry per process, on globalThis under Symbol.for('kenning.host')

**Status:** accepted (2026-11-18)

`session_spawn` and `session_stop` run inside kenning-pi, but the host that should carry them out (wherever's session pool, or the `@wherever-dev/pi` bridge in a terminal pi connected to a wherever server) is another package, which may have loaded its own copy of the kenning module: pnpm links, a bundled server, jiti loading an extension from source all produce separate module instances. A registry held in a module-level variable would be empty for whichever copy did not register. So the registry lives on `globalThis[Symbol.for('kenning.host')]`, the pattern wherever already uses for its server-process marker, with a versioned shape `{version: 1, entries: [{host}]}`. The key and the shape are a contract between packages.

`registerHost(host)` pushes an entry and returns a function that removes exactly that entry; `currentHost()` is the last one. So the most recently registered host wins, and unregistering restores the previous one whatever the order: the bridge can register over a server's host in the same process and step back when its connection drops. One host serves every session of its process (wherever runs many sessions in one server), so each `SpawnRequest` names the owner's session file and each `stop` names the session asking. With no host registered, kenning-pi uses the terminal default: a zellij pane, else a headless `pi -p` (D19).

**Rejected:** a module-level variable (two copies, two registries), an environment variable (inherited by every child process, which would then believe it is the server, and it cannot hold an object; wherever rejected an env var for the same reason), and a handshake on each session's `pi.events` bus (per session, while the host is per process, and the tools need it outside any event).

**Consequences:** any code in the process can register a host, including another extension. That is within ADR 0003's threat model (integrity against confused agents; an extension is trusted code), and a host gains nothing over provenance: the first prompt is always an `agent` message kenning queues itself.
