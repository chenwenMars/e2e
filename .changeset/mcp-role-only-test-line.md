---
"e2e": patch
---

`e2e mcp` now prints a test line for a control with no name, label, placeholder, text, or test id: `getByRole("spinbutton")` when it is the only one of its role, with a comment, else narrowed under a row or by position like other twins. Before, the action answered `No test line`.
