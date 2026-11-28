---
'@e2e-dev/core': patch
---

`app.open(path)` on a target with no app URL whose engine opens no links, such as a desktop or Electron app, says the call launches the pinned app and takes no path; it no longer tells the test to use `app.linkBase` or `device.openLink`, which such a target cannot.
