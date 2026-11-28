---
'@e2e-dev/core': patch
'e2e': patch
---

The default reporter says when an `agent.act` step ran live because its recording is `truncated`: the step's line ends with `not replayed: truncated`. Such a step ran live on every run with nothing in the terminal saying why. A step's `end` progress carries `cache` (`mode` and `reason`) for custom reporters.
