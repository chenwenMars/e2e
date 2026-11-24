---
'@e2e-dev/mobile': patch
---

Without a `device` option, a booted device another agent-device session claims while the engine's warm-up boots it, starts the iOS runner, or opens the app is swapped for the next free booted device, so two `launch()` hosts opened at the same moment no longer fail when a second device is free. A local target with `appPath` opens nothing during warm-up, so its hosts can still collide later. When no other device is free, a run with several workers drops that slot and goes on with one worker fewer; a `launch()` host, or a run whose last slot loses its device, fails with agent-device's refusal, where a worker used to fail at its start. A refusal at the runner start or the open by a short-lived agent-device command, such as another host's runner start or an install on the same simulator, moves the slot too; with no other device free the slot keeps its device and leaves it to the worker's start, as before.
