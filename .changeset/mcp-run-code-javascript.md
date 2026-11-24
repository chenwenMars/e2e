---
"e2e": minor
---

**Breaking:** `e2e mcp`'s `run_code` now runs JavaScript: variables, loops, `try`/`catch`, return values, and `console.log`, with `screen`, `app`, `expect`, `credentials`, `secrets`, and the engine's fixture (`browser` or `device`) in scope, the objects a test body gets. An agent reads, computes, and acts in one call. The result format changed: it shows what the code returned, then each line that ran. `open_session` lists the API the code can call.

The code runs in the server's Node process with a test file's authority, so the checks `run_code` applied to its statements are gone: a secret `fill` is no longer limited to the fields `type_secret` allows, a locator found by part of a text is no longer refused in a project with secrets, and reads return the real text. The result still shows `<secret:name>` where a configured secret value is. Lines need `await`: without it they start together and no longer run in order.
