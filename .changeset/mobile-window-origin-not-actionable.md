---
'@e2e-dev/mobile': patch
---

An iOS action on a node that agent-device refuses with `window-origin-unknown` now fails as `ACTION_FAILED` (`NOT_ACTIONABLE`) instead of an infrastructure `ENGINE_FAILURE`. agent-device sent nothing. The message says that node bounds, `boundingBox()` included, may be offset from screen coordinates, and for a tap names `screen.tapAt()` with a point not taken from them.
