---
'e2e': patch
---

`e2e mcp`: `run_code` in a session attached to a held test (`open_session {attach}`) now has the engine's fixture (`desktop`, `browser`, `device`) over the held test's app, as a standalone session's code has. Before, it failed with `desktop is not defined`, so an attached agent could not switch the window the test reads. The calls are the session's: they stay out of the held test's report and steps.
