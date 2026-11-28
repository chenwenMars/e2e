---
'e2e': patch
---

`e2e init` now registers the MCP server with the project's own package manager: `pnpm exec e2e mcp` in a pnpm project and `yarn exec e2e mcp` in a Yarn one (`yarn --silent exec -- e2e mcp` on Yarn 1), where it wrote `npx e2e mcp` before. `npx` exits with `EBADDEVENGINES` before the MCP handshake when the project's `devEngines` pins another manager, and the client showed only `Connection closed`. Run `e2e init` again to update an existing entry; it keeps the entry's other settings and, for an entry started as `<launcher> e2e mcp ...`, the arguments after `mcp`. A project that names its manager only in `devEngines`, with no `packageManager` field and no lockfile, is read as that manager's.

The commands e2e prints for a Yarn project now read `yarn exec -- e2e ...`: `yarn e2e` runs a package.json script named `e2e` before the binary. `e2e init` also tells Yarn 2 or later from Yarn 1 by the lockfile when the project has no `.yarnrc.yml` and no `packageManager` field, and by the Yarn that started it when the project has no lockfile yet.
