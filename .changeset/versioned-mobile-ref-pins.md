---
'@e2e-dev/mobile': patch
'@e2e-dev/limrun': patch
'@e2e-dev/e2b': patch
'@e2e-dev/testmu': patch
'@e2e-dev/revyl': patch
---

Use agent-device 0.21.44's ref formatter when pinning snapshot targets so interactions follow the installed SDK's live-ref grammar. Keep the hosted providers' SDKs and plugins on that version. E2B requires mobile 0.12.10 or newer so its client and the SDK installed in its sandbox match.
