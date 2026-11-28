---
'e2e': patch
---

`open_session`'s `app` now takes every key a config target's `app` does, such as `launchArguments`, `permissions`, and `command`, so a session opened with `engine` and no config file can launch its app with arguments. The keys are checked the way a config target's are.
