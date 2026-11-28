---
'@e2e-dev/core': patch
---

`resolveExpression` from `@e2e-dev/core/engine` takes `textQuery: 'text'`: a `text` query then matches a node's text alone, not its name too, as a browser's text query does, and a text query scoped to an element whose own text matches answers with that element. The default, `'nameOrText'`, is unchanged.
