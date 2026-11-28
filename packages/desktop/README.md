# @e2e-dev/desktop

The desktop engine for [`e2e`](https://www.npmjs.com/package/e2e): native
macOS apps, read and driven through the accessibility tree by a Rust driver
loaded into the test process (NAPI-RS), through the same
`@e2e-dev/core/engine` contract the browser and mobile engines implement. A
test written against `screen`, `expect`, `app`, and `agent` runs on a desktop
target unchanged.

> [!NOTE]
> This is a prototype, and it runs on macOS 13 or later only. A config with a desktop
> target still loads elsewhere, and its other targets run there when you pick
> them with `--target`. A run that includes the desktop target stops with
> `UNSUPPORTED_CAPABILITY` before any test starts.

## Install

```bash
npm install --save-dev e2e @e2e-dev/desktop
```

npm installs the driver built for your Mac with it
(`@e2e-dev/desktop-darwin-arm64` or `@e2e-dev/desktop-darwin-x64`); no Rust
toolchain is needed.

On macOS, the app that starts e2e (your terminal, IDE, or CI agent) needs
Accessibility permission, and Screen Recording for screenshots, in System
Settings > Privacy & Security. Run `npx e2e doctor` to check.

```ts title="e2e.config.ts"
import type { E2EConfig } from 'e2e';
import { desktop } from '@e2e-dev/desktop';

export default {
  targets: [{ name: 'mac', engine: desktop(), app: { appPath: 'build/MyApp.app' } }],
} satisfies E2EConfig;
```

`app.bundleId` names an installed app instead (`'com.apple.calculator'`, or an
app name), and `app.launchArguments` are passed to every launch.

```ts title="tests/sign-in.e2e.ts"
import { test } from '@e2e-dev/desktop';
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

- `app.open()` launches the app fresh, in the background (in the foreground
  with `e2e run --headed` or `desktop({ physicalInput: true })`), after quitting the
  copy the engine launched before. A copy you opened yourself is never read,
  driven, or quit; an app that runs one copy at a time hands the launch to
  it, so `app.open()` fails and names that copy. Every test ends with the app
  quit.
- The app gets only `HOME`, `USER`, `LOGNAME`, `SHELL`, `PATH`, `TMPDIR`,
  `LANG`, `LC_*`, and `__CF_USER_TEXT_ENCODING` of the run's environment, and
  `E2E_DESKTOP_LAUNCH`, the token the engine finds its copy by. An app whose
  environment macOS hides (its own apps, Mac App Store apps, and
  builds signed with `restrict`) gets the token as its last argument too,
  `-E2EDesktopLaunch=<token>`.
- An observation is one snapshot of the app's window. Roles map
  onto the ARIA names other engines use (`textbox`, `checkbox`, `combobox`,
  `button`); the developer id (`AXIdentifier`) is the node's test id, so
  `getByTestId` finds it.
- Actions go through the accessibility API, and keys and typing into the
  app's own event queue, so they leave your pointer, focus, and typing alone.
  `desktop({ physicalInput: true })` brings the app forward and allows physical
  input: `doubleTap`, `hover`, point-addressed taps, and keys through the
  real keyboard.
- A fill passes its text to the driver in the test process, and the driver
  hands it to the app under test through the Accessibility API; no helper
  process sees it. A secure field reports no value, and screenshots paint over its
  bounds; when a secure field has no bounds, the screenshot is withheld.
- Not supported yet: the menu bar, and web content (a browser window, an
  Electron app, a web view).
- One worker per target: its workers would share one screen. Two desktop
  targets run at the same time. With `physicalInput: true` they would share the
  pointer and keyboard too, so set the run's `workers: 1`.

## Building the driver

In a checkout, `pnpm --filter @e2e-dev/desktop build:native` builds the
driver (`crates/e2e-desktop-napi`, a Rust crate in the repository's Cargo
workspace) with `cargo` for this Mac into this package's directory, and the
engine loads it from there. It needs a Rust toolchain from
[rustup](https://rustup.rs).

## License

Apache-2.0
