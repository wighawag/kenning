# Two packages, kenning and kenning-pi, under AGPL-3.0-only

**Status:** accepted (2026-11-17)

`kenning` is the core library and the CLI, with no runtime dependencies, so wherever and dorfl import it without pulling in pi. `kenning-pi` is the pi extension and skill, installed with `pi install npm:kenning-pi`, depending on `kenning` and declaring pi's packages as `"*"` peers. This is memonaut's split, for the same reason.

The license is AGPL-3.0-only, as for memonaut, wherever and the repositories that will use it. Every current importer is AGPL already. If pi upstream or other harnesses should adopt kenning, MPL-2.0 for the core is the alternative to reconsider, before outside contributions make relicensing need their authors.

**Rejected:** one package (every non-pi importer gets peer-dependency noise and a muddier seam), an `@kenning` scope (not owned), MIT now (no consumer needs it).
