---
'e2e': patch
'@e2e-dev/core': patch
---

`agent.waitFor` judges a screen change as soon as it sees it instead of first waiting out `interval` after the previous judgment, so a condition that comes true mid-wait resolves within about 500 ms plus one model call rather than up to 3 s later. While the screen keeps changing (a progress counter, a clock), it still judges at most once per `interval`.
