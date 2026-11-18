---
'@e2e-dev/core': patch
'e2e': patch
'@e2e-dev/html-reporter': patch
---

A session a test opens with `launch()` is now in the test's report: its steps under `launch-1`, `launch-2`, in the order they ran, its model usage counted with the test's, and its video kept beside the test's when the test records one. Steps and video artifacts carry an `actor`, and so does `progress.identity` for reporters. The test owns what it opened: a host or session it leaves open is closed when the test ends, a step it leaves running fails the test with `STEP_NOT_AWAITED`, and a timeout cuts a session's step as it cuts the test's own. The trace page, the HTML report, and the Markdown and JUnit failure text name the session, and the HTML report plays each step in its own session's video. While such a session records for the test, `app.startRecording()` on it fails with `UNSUPPORTED_CAPABILITY`, as it does on the test's own session.
