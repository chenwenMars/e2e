---
'@e2e-dev/core': patch
'e2e': patch
'@e2e-dev/web': patch
'@e2e-dev/mobile': patch
'@e2e-dev/desktop': patch
---

Add `screen.scrollTo(edge)` and `locator.scrollTo(edge)`, which scroll the page or a list to its `'top'`, `'bottom'`, `'left'`, or `'right'` edge, as far as it goes. On the web the screen scrolls the page, or the pane under the viewport's center when the page does not scroll; a locator scrolls its node or the nearest ancestor that scrolls. A device drags until a drag moves nothing. The engine contract gains the `scrollTo` action kind, outside SPI v1, which the web and mobile engines declare, so both now need `@e2e-dev/core` and `e2e` 0.25.1 or newer; the desktop engine does not declare it, so `scrollTo` there fails with `UNSUPPORTED_CAPABILITY`.
