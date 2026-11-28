---
'e2e': patch
'@e2e-dev/core': patch
---

`e2e mcp`: an action on a node id that only an earlier observation listed now prints its test line. The action already found the node again on the newest screen by what it read as, when exactly one node there reads the same, as an agent step does, but the line looked for the id on the newest screen only and printed `No test line: not on the newest screen`. The line now finds that node by the rule the action uses, which goes by role, name, test id, placeholder, and input purpose, so two controls told apart by test id are told apart in the line too. An `ExecutorNode` from `e2e/agent` now carries the node's `testId`, as the listing shows it.
