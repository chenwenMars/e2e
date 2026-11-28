---
'@e2e-dev/core': patch
'e2e': patch
---

Add `maxContextBytes` to an agent: the bytes its `context` may take, 1024 through 65536, default 16384. The limit was fixed at 16384 since the top-level `limits` key was removed. A `context` that leaves the screen no room under the agent's `maxInputTokens` now fails the config load with `INVALID_CONFIG` instead of failing each model call.
