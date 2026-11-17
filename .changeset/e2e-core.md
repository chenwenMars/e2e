---
'e2e': patch
'@e2e-dev/core': patch
'@e2e-dev/web': patch
'@e2e-dev/mobile': patch
---

New package `@e2e-dev/core`: drive a browser or a native app from plain code, with no test runner, config file, or report. `launch(web())` prepares an engine and returns a host; `host.newSession()` opens an isolated session holding `screen`, `app`, `platform`, and the engine's fixture. `session.saveState()` captures state in memory, and `SessionState.export({ key })` returns it only AES-256-GCM encrypted, as `session-state-1` bytes. Secrets go to `launch({ secrets })` and fill through `host.secret(name)`. `createAgent(session, { model, cache })` from `@e2e-dev/core/agent` adds the agent: with `cache`, every `act` names its recording with `cacheKey`.

`@e2e-dev/web` and `@e2e-dev/mobile` need `e2e` only for the `test` their main entry exports, so their `e2e` peer is optional. Without `e2e`, the main entry still loads and its engine factory works; `test`, `describe`, and the hooks throw `RUNNER_NOT_INSTALLED` when called. Its types still name `e2e`, so a TypeScript program without it imports from the `/engine` entry or sets `skipLibCheck`. `@e2e-dev/core/agent` also exports what `e2e/agent` does, `defineTool` among it.

Device targets take `app.linkBase`: `app.open('/orders/42')` then opens the path as a link in the pinned app, through the new optional engine hook `session.openLink` (protocol method `session/openLink`). `@e2e-dev/mobile` implements it.

`@e2e-dev/web/engine` and `@e2e-dev/mobile/engine` export the engine factories and their types without `test`, so a program that only drives an engine never loads the test runner. `defineEngine<Fixtures>()` and `EngineHandle<Fixtures>` now carry the fixtures an engine contributes as a type, and `defineEngine` requires a factory for each one `Fixtures` names: `web()` is an `EngineHandle<WebFixtures>`, `mobile()` an `EngineHandle<MobileFixtures>`. `defineEngine` refuses a fixture named `close`, `saveState`, or `setDefaultTimeout`, the methods of a session. `@e2e-dev/core/engine` (and `e2e/engine`) exports `isRefusedLinkScheme`, the scheme list app links are refused by, which `@e2e-dev/mobile` now uses for `device.openLink`.
