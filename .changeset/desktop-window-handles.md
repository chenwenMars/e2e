---
'@e2e-dev/desktop': minor
'@e2e-dev/desktop-darwin-arm64': minor
'@e2e-dev/desktop-darwin-x64': minor
---

**Breaking:** the `desktop` fixture now works like `browser` and `electron`. `desktop.useWindow()` is gone: `desktop.windows()` returns window handles with `title()`, `isActive()`, `isClosed()`, `activate()`, and `close()`, `desktop.waitForWindow(trigger)` runs the step that opens a window and makes it active, and `desktop.window({ title })` waits for a window by title. When the active window closes, `screen` reads the focused window again instead of failing. `desktop.press(key)` is now `desktop.keyboard.press(key)`, beside a new `desktop.keyboard.type(text)`. The `headed` option is now `physicalInput`, since it turns on the real pointer and keyboard, which the run's `--headed` does not.
