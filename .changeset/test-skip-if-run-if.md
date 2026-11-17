---
'e2e': patch
'@e2e-dev/core': patch
---

Add `test.skipIf(condition)` and `test.runIf(condition)`, which skip or run a test based on a condition, without wrapping `test()` in an `if`.
