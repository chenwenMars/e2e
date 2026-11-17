---
'@e2e-dev/core': patch
---

Actions, `waitFor`, and assertions that miss on their first read now read again at 20 ms and 50 ms, then every 100 ms from the start of the wait, as before. A node or state that arrives in the first 100 ms is seen up to 80 ms sooner, and one that arrives later is seen no later than before.
