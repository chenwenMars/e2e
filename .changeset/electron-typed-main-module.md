---
'@e2e-dev/electron': patch
---

`electron.evaluate` types the `electron` module its function receives with the project's own `electron` package, now an optional peer, in place of `any`.
