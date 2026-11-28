---
'@e2e-dev/revyl': patch
---

Adds `revylBrowsers()` from `@e2e-dev/revyl/web`, a browser provider for `@e2e-dev/web` that runs each test attempt in a Revyl web session's Chrome over CDP, and saves Revyl's recording of the session as the attempt's video. `@e2e-dev/mobile` and `@e2e-dev/web` are now optional peers, so a project installs only the engine it uses.
