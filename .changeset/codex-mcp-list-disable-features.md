---
'@e2e-dev/acp': patch
---

Pass `--disable <feature>` for every feature in `CODEX_FEATURES_OFF` when running `codex mcp list --json`, so MCP servers provided by disabled Codex plugins (such as `codex_app` or `cua_repl`) are not added to `mcp_servers` without a transport definition.
