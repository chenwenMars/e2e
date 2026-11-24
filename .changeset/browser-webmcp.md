---
'@e2e-dev/web': patch
---

`browser.webmcp.tools()` lists the tools a page registers through WebMCP (`document.modelContext`) and `browser.webmcp.callTool(name, input)` calls one, from test code with no model involved. `web({ webmcp: true })` launches Chromium or Firefox with WebMCP on; it is `INVALID_CONFIG` with `connect`, a browser provider, or WebKit. On a page without WebMCP, in a browser e2e launched or one it attaches to, both calls fail with `UNSUPPORTED_CAPABILITY` and say how to turn it on. A call to a tool the page does not register, one that throws, or one that navigates the page or runs out of time before it answers is `ACTION_FAILED`. [WebMCP](https://e2e.com/docs/reference/web#webmcp)
