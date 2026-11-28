---
'@e2e-dev/core': patch
---

`expressionSelectors(expression)` from `@e2e-dev/core/engine` lists the platform selectors a locator expression names. `resolveExpression` answers a selector synchronously, so an engine whose selector language sits across a protocol queries these first and answers from what it read, without walking the expression itself.
