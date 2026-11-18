---
'@e2e-dev/core': patch
'e2e': patch
---

A secret passed only to `launch()` inside an `e2e run` test is now redacted from the test's report, trace, downloads, and model input until the test ends, and the host's sessions redact the config's secrets. Every session in a process redacts the secrets of the hosts and sessions open beside it, on a browser and on a device alike, without carrying them into a saved state. An error a session throws no longer carries a secret in its `details`.
