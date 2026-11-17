---
'e2e': patch
---

The CLI starts without loading the YAML and TOML parsers, which only `e2e init` uses to write a CI pipeline and a Codex MCP config. Every command starts a little faster.
