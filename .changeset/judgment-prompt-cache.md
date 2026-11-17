---
'@e2e-dev/core': patch
---

Every `agent.act` step on an engine that can fill secrets now gets the same tool set, so a step with a `Secret` param reads the provider prompt cache like the other steps. `type_secret` is always offered there, and the step's opening message lists the secrets it declares. A judgment prompt now puts the test's title after its fixed request text, which lengthens the prefix a provider can cache.
