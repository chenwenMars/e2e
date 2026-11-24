---
'@e2e-dev/mobile': patch
---

`device.pressRemote(key)` presses a TV remote button on an Android TV or an Apple TV through agent-device's `tv-remote`: the D-pad (`up`, `down`, `left`, `right`, `select`), `back`, `menu`, `home`, and the media keys (`play`, `pause`, `play-pause`, `stop`, `rewind`, `fast-forward`, `next`, `previous`). A device without the button rejects with `UNSUPPORTED_CAPABILITY`, and a name outside the list is `INVALID_ARGUMENT`. `tvTools(...engines)` from `@e2e-dev/mobile/tools` gives an agent the same buttons as a `tv_remote` tool; spread it beside `mobileTools`.
