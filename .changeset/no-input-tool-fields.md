---
'e2e': patch
'@e2e-dev/core': patch
---

A built-in agent tool that takes no input drops keys the model sends and runs. `observe`, `back`, `dismiss_keyboard`, and `screenshot` (when it has no `path`) used to reject a padded call such as `screenshot({"description": "check the home screen"})`, and some models resent that refusal until the step budget ended. A tool that declares fields still rejects a key it does not declare.
