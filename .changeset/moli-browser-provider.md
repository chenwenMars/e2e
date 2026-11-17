---
"@e2e-dev/moli": patch
---

Add `moli()` for `web({ browser: moli() })`. Each worker gets a local Moli CDP server with layout and resources enabled, automatic port selection, startup cancellation, and process cleanup when its lease ends.
