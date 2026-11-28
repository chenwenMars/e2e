# @e2e-dev/electron

The Electron engine for [`e2e`](https://www.npmjs.com/package/e2e): an
Electron app's windows, read through Chromium's accessibility tree over the
DevTools protocol and driven with trusted input, through the same
`@e2e-dev/core/engine` contract the browser, mobile, and desktop engines
implement. A test written against `screen`, `expect`, `app`, and `agent` runs
on an Electron target unchanged.

It is also the reference for an engine built outside this repository: it
imports only `@e2e-dev/core/engine` and speaks the DevTools protocol itself,
with no automation library and never another engine. [Engines](https://e2e.com/docs/engines) lists what
building it changed in the contract.

## Install

```bash
npm install --save-dev e2e @e2e-dev/electron electron
```

The engine starts the `electron` package installed in the project, and
downloads its binary one time per run when it is missing. Run
`npx e2e doctor` to check.

```ts title="e2e.config.ts"
import type { E2EConfig } from 'e2e';
import { electron } from '@e2e-dev/electron';

export default {
  targets: [{ name: 'electron', engine: electron(), app: { appPath: '.' } }],
} satisfies E2EConfig;
```

`app.appPath` is the app's directory or main script, and `app.launchArguments`
are the switches every launch gets, the app's own and Chromium's. For a packaged app, pass
`electron({ executablePath })` and leave out `appPath`.

```ts title="tests/sign-in.e2e.ts"
import { test } from '@e2e-dev/electron';
import { credentials, expect } from 'e2e';

test('signs in', async ({ app, screen }) => {
  await app.open();
  await screen.getByRole('textbox', 'Username').fill('ada');
  await screen.getByRole('textbox', 'Password').fill(credentials.user('ada').password);
  await screen.getByRole('button', 'Sign in').tap();
  await expect(screen.getByTestId('status')).toContainText('Signed in');
});
```

## How it works

- **Launch.** `app.open()` starts the app on an empty user-data directory and
  waits for a window to load. Every test ends with the app quit.
- **Read.** Chromium's accessibility tree joined with one DOM snapshot.
  Nothing runs in the app's page to read it.
- **Act.** Trusted mouse and keyboard input, once the node is enabled, on
  screen, and topmost at its point.
- **Windows.** The agent sees them as tabs. The `electron` fixture has
  `evaluate` (main process), `windows`, `waitForWindow`, `window`,
  `waitForDownload`, `onDialog`, and `locator` (CSS).
- **Video.** The shown window's screencast, encoded to one `.webm` by ffmpeg,
  which the engine downloads on the first recording when the machine has none.
- **Secrets.** Password fields report no value, and screenshots paint them
  and nested documents over.

## Limits

Not on Electron, because the platform has no such thing:

| What | Instead |
| --- | --- |
| `prompt()` | Electron does not implement it. Build the prompt in the page |
| Headless mode | On Linux CI, run under a virtual display such as `xvfb-run` |
| Menu accelerators from key presses | Call the menu item from `electron.evaluate` |

Not supported yet:

| What | Until then |
| --- | --- |
| Content inside an `iframe` or `webview` | A `webview` guest is listed as a window: `electron.window()` |
| Routes and cookies | `session.defaultSession` in `electron.evaluate` |
| Session save and restore | |

[The Electron guide](https://e2e.com/docs/electron) lists every difference
from the web.

## License

Apache-2.0
