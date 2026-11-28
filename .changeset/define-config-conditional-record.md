---
"@e2e-dev/core": patch
"e2e": patch
---

An entry of `secrets`, `credentials`, `services`, `agents`, an agent's `tools` or `providerOptions`, or a target's `app.permissions` may be `undefined`. So `defineConfig` keeps the config's inferred type when one of them is written as `ci ? { … } : {}` in a project without `exactOptionalPropertyTypes`. Before, the config fell back to `E2EConfig`, and `test.extend` rejected `typeof config` with an error that blamed a type annotation, or `app.permissions` failed to type-check. An `undefined` service, agent, tool, provider, or permission is left out. For an agent this is new: `agents: { buyer: undefined }` used to create `buyer` with the default options. A secret set to `undefined` takes its value from `E2E_SECRET_<NAME>`, as before. A credential set to `undefined` now takes its username and password from `E2E_USER_<NAME>_USERNAME` and `E2E_USER_<NAME>_PASSWORD`, where before it was `INVALID_CONFIG`.
