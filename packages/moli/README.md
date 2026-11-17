# @e2e-dev/moli

[Moli](https://github.com/lexmount/moli) browsers for
[`e2e`](https://www.npmjs.com/package/e2e). Each worker slot gets a local
`moli serve` process on an available port, stopped when the run ends.

## Install

Install the [Moli binary](https://github.com/lexmount/moli#direct-installation), then:

```bash
npm install --save-dev e2e @e2e-dev/web @e2e-dev/moli
```

## Usage

```ts title="e2e.config.ts"
import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { moli } from '@e2e-dev/moli';

export default {
  targets: [
    {
      name: 'moli',
      engine: web({ browser: moli() }),
      app: { url: 'http://localhost:3000' },
    },
  ],
} satisfies E2EConfig;
```

The provider finds the binary through `binary`, `MOLI_PATH` in the run's
environment, `PATH`, or `~/.local/bin/moli`. It enables `--layout` and
`--resource` by default. Set `layout: false` or `loadResources: false` to
omit those flags; `args` passes additional `moli serve` flags.

A server that does not expose CDP within ten seconds fails its lease.
Cancelled startup stops the process. Release sends SIGTERM, then SIGKILL
after five seconds if the process keeps running. The provider supports
worker scope only.

See [the integration guide](https://e2e.com/docs/integrations/moli) for setup
and attaching to a server you manage. Check [Moli's upstream issues](https://github.com/lexmount/moli/issues)
for CDP compatibility gaps.

## License

Apache-2.0
