---
"@e2e-dev/mobile": patch
"@e2e-dev/e2b": patch
"@e2e-dev/limrun": patch
"@e2e-dev/testmu": patch
---

Update agent-device to 0.21.38. Opening an app now waits for the app's first screen before the first capture, and on Android a relaunch accepts a package that Android restarts at once. On iOS, `device.back()` presses the navigation bar's back button when there is one, keyboard dismiss and enter have a bounded idle wait, and agent-device establishes the screen origin of a full-screen private accessibility root.
