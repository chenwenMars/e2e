---
'e2e': patch
'@e2e-dev/core': patch
---

Add `test.slow()` and `test.slow(condition, reason)` to triple the running test's timeout from its body or a `beforeEach` hook, or a `beforeAll` hook's own timeout, as Playwright's `test.slow()` does.
