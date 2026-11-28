---
'e2e': patch
---

`e2e mcp`: the point tools (`tap_at`, `hover_at`, `drag_at`, `type_at`, `press_at`, `select_at`) now print a test line, and `test_lines` keeps it. A point tool that acts on the listed control under its point prints that control's locator line. A bare tap prints `screen.tapAt({ x, y })` in the viewport's pixels. When no line can repeat the action, the result says `No test line:` and why, and the draft keeps the step as a comment. Before, the point tools printed nothing and the draft left their steps out.
