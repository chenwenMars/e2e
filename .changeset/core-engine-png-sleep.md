---
'@e2e-dev/core': patch
---

`@e2e-dev/core/engine` exports `readPngSize`, which reads a PNG capture's size from its header, and `sleep`, an abortable wait, so an engine carries no copy of either.
