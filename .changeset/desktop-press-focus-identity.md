---
'@e2e-dev/desktop': patch
---

`press` and typing no longer fail with "did not keep keyboard focus" on a control that changes size as it takes focus, such as a search field that grows, when no name or id tells the control apart from its siblings. The driver checks focus by the control itself rather than by its position, which also saves a read of the whole window on every press.
