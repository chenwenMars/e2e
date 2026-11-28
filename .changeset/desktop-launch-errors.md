---
'@e2e-dev/desktop': patch
---

`app.open()` now says why a launch left no window to drive. When the launched process exits and a copy of the app was already running, the error names that copy and says to quit it first, since a single-instance app hands the launch to it. When the window cannot be read through accessibility, the error says how many windows the last read listed, how many were unreadable, and the failure the last read answered with.
