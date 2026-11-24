---
"@e2e-dev/core": patch
---

A saved setup session (`session-1`) now loads only with its full 16-byte authentication tag. Before, a file whose tag was cut short, or written as a byte array, still loaded. Such a file, or one with a missing IV, now fails with `SESSION_INVALID` instead of loading or throwing a raw `TypeError`. `SessionState.import` already refused these documents.
