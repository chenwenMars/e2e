---
'e2e': patch
'@e2e-dev/core': patch
---

The JUnit report keeps the `\r\n` line breaks of failure messages and skip reasons instead of writing U+FFFD: `junit.xml` reads `&#13;&#10;`, and `report.json` and reporter events keep the `\r`. A `\r` with no `\n` after it still becomes U+FFFD, and the terminal output is unchanged.
