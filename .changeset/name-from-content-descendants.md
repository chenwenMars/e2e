---
'@e2e-dev/web': patch
---

A name from content now leaves out descendants whose own role is not named from content, as Chrome and Playwright do: a parent tree item is `treeitem "src"`, not every label under it, and a tab with a `status` badge is `tab "Inbox"`, not `tab "Inbox 3"`.
