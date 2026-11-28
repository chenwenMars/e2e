---
'@e2e-dev/core': patch
---

Accept spaces inside a name in the object form of `app.launchArguments`, so a user-defaults key such as `'NSSplitView Subview Frames Main'` no longer fails with `INVALID_CONFIG`. A name with a control character, a space at either end, or any other whitespace is still refused.
