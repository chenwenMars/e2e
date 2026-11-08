---
"e2e": patch
---

An agent step no longer waits two seconds after a caret key that changes nothing. An arrow, Home, End, or select-all pressed in a text field that already holds the focus waits 150 ms for the screen to react, not the full window. A tap, the first key that gives a field the focus, and a key batched after another action still wait the full window. A replay of a recorded rich-text editing flow takes 9.3 s instead of 20.5 s.
