import { readFileSync } from 'node:fs';
import { Transformer } from '@napi-rs/image';
import { test } from '@e2e-dev/electron';
import { credentials, expect } from 'e2e';

/** The engine error code under a failed step. */
function causeCode(error: unknown): string | undefined {
  return (error as { cause?: { code?: string } } | undefined)?.cause?.code;
}

test.describe('sign-in window', () => {
  test.beforeEach(async ({ app }) => {
    await app.open();
  });

  test('signs in through the preload bridge with every control set', async ({ screen, electron }) => {
    const ada = credentials.user('ada');
    await expect(screen.getByRole('status').first()).toHaveText('Not signed in');
    await screen.getByRole('textbox', 'Username').fill(ada.username);
    await screen.getByRole('textbox', 'Password').fill(ada.password);
    await screen.getByRole('checkbox', 'Remember me').check();
    await expect(screen.getByRole('checkbox', 'Remember me')).toBeChecked();
    await screen.getByRole('combobox', 'Plan').selectOption('Team');
    await expect(screen.getByRole('combobox', 'Plan')).toHaveValue('Team');
    await screen.getByRole('button', 'Sign in').tap();
    await expect(screen.getByTestId('status')).toHaveText('Signed in as ada on Team, remembered (main process saw 7 characters)');
    const signIns = await electron.evaluate(() => (globalThis as unknown as { testbedState: { signIns: unknown[] } }).testbedState.signIns);
    expect(signIns).toEqual([{ username: 'ada', plan: 'Team', remember: true }]);
    // The function's own error is the test's, whatever it says.
    const thrown = await electron.evaluate(() => {
      throw new Error('the dialog has been closed by the user');
    }).then(() => undefined, (error: unknown) => error);
    expect(thrown).toMatchObject({ code: 'EVALUATE_FAILED' });
    expect(await electron.evaluate((_main, arg: { readonly times: number }) => arg.times * 2, { times: 3 })).toBe(6);
    // @ts-expect-error A function that takes an argument must be given one.
    const missingArgument = (): Promise<number> => electron.evaluate((_main, arg: { readonly times: number }) => arg.times);
    expect(typeof missingArgument).toBe('function');
    // The module is typed by the project's electron package.
    expect(await electron.evaluate(({ app: main }) => main.isReady())).toBe(true);
    // @ts-expect-error Electron's app has no such method.
    const unknownMethod = (): Promise<unknown> => electron.evaluate(({ app: main }) => main.notAnElectronMethod());
    expect(typeof unknownMethod).toBe('function');
  });

  test('reads controls by test id and placeholder, and refuses an empty password', async ({ screen }) => {
    await screen.getByPlaceholder('ada').fill('grace');
    await expect(screen.getByTestId('username')).toHaveValue('grace');
    await expect(screen.getByTestId('username')).not.toBeEmpty();
    await screen.getByTestId('username').clear();
    await expect(screen.getByTestId('username')).toHaveValue('');
    await expect(screen.getByTestId('username')).toBeEmpty();
    await expect(screen.getByTestId('wide-result')).toBeEmpty();
    await screen.getByTestId('sign-in').tap();
    await expect(screen.getByTestId('status')).toHaveText('Password is required');
  });

  test('reads what a control submits: a select its option value, a checkbox on', async ({ screen }) => {
    const region = screen.getByTestId('region');
    await expect(region).toHaveValue('eu-1');
    await region.selectOption('America');
    await expect(region).toHaveValue('us-1');
    expect(await screen.getByRole('checkbox', 'Remember me').inputValue()).toBe('on');
    await expect(screen.getByTestId('due')).toHaveValue('2026-01-02');
    await screen.getByTestId('due').fill('2026-03-04');
    await expect(screen.getByTestId('due')).toHaveValue('2026-03-04');
    const malformed = await screen.getByTestId('due').fill('next week', { timeout: 1000 }).then(() => undefined, (error: unknown) => error);
    expect(String(malformed)).toContain('does not take');
    // A refused value leaves the field as it was.
    await expect(screen.getByTestId('due')).toHaveValue('2026-03-04');
    const seats = screen.getByTestId('seats');
    const notNumber = await seats.fill('many', { timeout: 1000 }).then(() => undefined, (error: unknown) => error);
    expect(String(notNumber)).toContain('does not take');
    await expect(seats).toHaveValue('7');
    await seats.fill('12');
    await expect(seats).toHaveValue('12');
    await expect(screen.getByTestId('notes')).toHaveValue('Bring the badge');
    // A select holds its options' text, so it is not empty, and with no readonly attribute it is editable.
    await expect(region).not.toBeEmpty();
    await expect(region).toBeEditable();
  });

  test('waits for an option that arrives after the page loads', async ({ screen }) => {
    await screen.getByTestId('room').selectOption('Studio');
    await expect(screen.getByTestId('room')).toHaveValue('Studio');
  });

  test('refuses an option in a disabled group', async ({ screen }) => {
    const refused = await screen.getByRole('combobox', 'Plan').selectOption('Legacy', { timeout: 2000 }).then(() => undefined, (error: unknown) => error);
    expect(String(refused)).toContain('is disabled');
    await expect(screen.getByRole('combobox', 'Plan')).toHaveValue('Pro');
  });

  test('submits with the Enter key and types into the focused field', async ({ screen }) => {
    await screen.getByTestId('username').tap();
    await screen.getByTestId('username').pressSequentially('lin');
    await screen.getByTestId('password').fill('correct horse');
    await screen.getByTestId('password').press('Enter');
    await expect(screen.getByTestId('status')).toHaveText('Signed in as lin on Pro (main process saw 13 characters)');
  });

  test('refuses to type into a field that hands focus on to another', async ({ screen }) => {
    const refused = await screen.getByTestId('handoff').fill('typed', { timeout: 2000 }).then(() => undefined, (error: unknown) => error);
    expect(String(refused)).toContain('did not keep keyboard focus');
    const typed = await screen.getByTestId('handoff').pressSequentially('typed', { timeout: 2000 }).then(() => undefined, (error: unknown) => error);
    expect(String(typed)).toContain('did not keep keyboard focus');
    await expect(screen.getByTestId('username')).toHaveValue('');
  });

  test('fills a field that swallows key presses, since fill sends none, and clears it with a Delete key, as web() does', async ({ screen }) => {
    const invite = screen.getByTestId('invite');
    await invite.fill('ABC-123');
    await expect(invite).toHaveValue('ABC-123');
    // An empty fill is a Delete key, as Playwright's: a field that swallows keys keeps its text, as on the web.
    await invite.clear();
    await expect(invite).toHaveValue('ABC-123');
  });

  test('sends no text once a fill has run out of time', async ({ screen }) => {
    const refused = await screen.getByTestId('slow').fill('late', { timeout: 1000 }).then(() => undefined, (error: unknown) => error);
    // Focus went to the field before the time ran out, so the step may have reached the app and is never retried.
    expect(causeCode(refused)).toBe('ACTION_MAY_HAVE_COMMITTED');
    // The focus handler returns after two seconds; a fill still running then would type now.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await expect(screen.getByTestId('slow')).toHaveValue('');
  });

  test('taps a button wider than the window', async ({ screen }) => {
    await screen.getByRole('button', 'Wide action').tap();
    await expect(screen.getByTestId('wide-result')).toHaveText('Wide action ran');
  });

  test('drags to a drop zone below the edge of the window', async ({ screen }) => {
    await screen.getByRole('button', 'Drag me').dragTo(screen.getByRole('button', 'Drop here'));
    await expect(screen.getByTestId('drag-result')).toHaveText('Dropped drag-source on the zone');
    // A drop target another element covers is not dropped on.
    const covered = await screen.getByRole('button', 'Drag me').dragTo(screen.getByRole('button', 'Covered zone'), { timeout: 1500 }).then(() => undefined, (error: unknown) => error);
    expect(String(covered)).toContain('would receive the click');
  });

  test('stops typing once pressSequentially has run out of time', async ({ screen }) => {
    const laggy = screen.getByTestId('laggy');
    const refused = await laggy.pressSequentially('abcdefgh', { timeout: 1000 }).then(() => undefined, (error: unknown) => error);
    // The time runs out between two keys or under one: either way the step says it timed out, and is never retried.
    expect(['OPERATION_TIMEOUT', 'ACTION_MAY_HAVE_COMMITTED']).toContain(causeCode(refused));
    // Eight keys take 2.4 seconds; typing that went on past the timeout would finish by now.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect((await laggy.inputValue()).length).toBeLessThan(8);
  });

  test('refuses a key the keyboard has no key for, before focus moves', async ({ screen }) => {
    const refused = await screen.getByTestId('username').press('é').then(() => undefined, (error: unknown) => error);
    expect(refused).toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    await screen.getByTestId('username').press('$');
    await expect(screen.getByTestId('username')).toHaveValue('$');
  });

  test('waits for enabled the way the tree reports it', async ({ screen }) => {
    const locked = screen.getByRole('button', 'Locked action');
    await expect(locked).toBeDisabled();
    const refused = await locked.tap({ timeout: 1000 }).then(() => undefined, (error: unknown) => error);
    expect(String(refused)).toContain('it is disabled');
    const field = screen.getByTestId('locked-field');
    const notFilled = await field.fill('typed', { timeout: 1000 }).then(() => undefined, (error: unknown) => error);
    expect(String(notFilled)).toContain('it is disabled');
    await expect(field).toHaveValue('');
    // A nearer aria-disabled="false" enables a control again.
    await screen.getByRole('button', 'Unlocked action').tap();
    await expect(screen.getByTestId('link-result')).toHaveText('Unlocked action ran');
    // A disabled fieldset disables its form controls, not a link inside it.
    await screen.getByRole('link', 'Open archive').tap();
    await expect(screen.getByTestId('link-result')).toHaveText('Archive opened');
  });

  test('reads and fills an editing host as text', async ({ screen }) => {
    const rich = screen.getByTestId('rich');
    await expect(rich).toContainText('Second paragraph');
    await expect(screen.getByText('Second paragraph')).toHaveCount(1);
    await rich.fill('Rewritten');
    await expect(rich).toHaveText('Rewritten');
  });

  test('reads an editing host with no role as editable', async ({ screen }) => {
    await expect(screen.getByTestId('plain-notes')).toBeEditable();
    await expect(screen.getByTestId('rich')).toBeEditable();
  });

  test('counts a CSS locator in document order where aria-owns reorders the tree', async ({ electron }) => {
    await expect(electron.locator('button.ordered').first()).toHaveText('DOM first');
    await expect(electron.locator('button.ordered').last()).toHaveText('DOM second');
  });

  test('attaches a file by path and refuses a path that names nothing', async ({ screen }) => {
    const attachment = screen.getByTestId('attachment');
    await attachment.setInputFiles('app/settings.html');
    await expect(screen.getByTestId('attachment-name')).toHaveText('settings.html');
    const missing = await attachment.setInputFiles('app/no-such-file.txt').then(() => undefined, (error: unknown) => error);
    expect(missing).toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  test('passes the launch arguments to the app', async ({ screen }) => {
    await expect(screen.getByRole('heading', { name: 'Hello from e2e', level: 1 })).toBeVisible();
  });

  test('counts taps and reads text a locator scopes', async ({ screen, electron }) => {
    const counter = screen.getByRole('region', 'Counter');
    await counter.getByRole('button', 'Add one').tap();
    await counter.getByRole('button', 'Add one').dblclick();
    await expect(screen.getByTestId('count')).toHaveText('3');
    await expect(electron.locator('#increment')).toHaveText('Add one');
    // Each run of text is found on its own, as on the web, and the line reads as all of them.
    await expect(screen.getByText('$10')).toBeVisible();
    await expect(screen.getByText('Price')).toHaveCount(1);
    await expect(screen.getByTestId('price')).toHaveText('Price $10');
    // A label wrapping a field is a container Chromium's tree leaves out; a selector still reaches it.
    await expect(electron.locator('#sign-in > label').first()).toHaveText('Username');
    await expect(electron.locator('#sign-in > label')).toHaveCount(4);
    // A web component's content is in an open shadow root.
    await expect(electron.locator('.badge')).toHaveText('Beta');
    // A hidden element is still there for a selector to count.
    await expect(electron.locator('#spinner')).toHaveCount(1);
    await expect(electron.locator('#spinner')).toBeHidden();
    // A hidden match keeps its place in the document and its text, and a test id finds it too.
    await expect(electron.locator('.row').first()).toHaveAttribute('id', 'row-first');
    expect(await electron.locator('.row').first().textContent()).toBe('First row');
    await expect(screen.getByTestId('row')).toHaveCount(2);
    await expect(screen.getByTestId('row', { visible: true })).toHaveText('Second row');
    // A hidden password field is still a secure one: its attributes are not read.
    const denied = await electron.locator('#stashed-key').getAttribute('value').then(() => undefined, (error: unknown) => error);
    expect(denied).toMatchObject({ code: 'POLICY_DENIED' });
    // Reads at the same time keep their own handles.
    expect(await Promise.all([electron.locator('#increment').count(), electron.locator('#items li').count()])).toEqual([1, 40]);
  });

  test('reads inline markup, images, and a label the way the web does', async ({ screen }) => {
    // An inline element Chromium leaves out of the tree is visible, and its text is read once.
    await expect(screen.getByTestId('inline')).toBeVisible();
    await expect(screen.getByTestId('inline')).not.toBeHidden();
    await expect(screen.getByText('inline text')).toHaveCount(1);
    // A wrapper with no box of its own shows what it holds.
    await expect(screen.getByTestId('contents')).toBeVisible();
    // Text keeps the white space of its source, and none between inline markup.
    await expect(screen.getByTestId('sentence')).toHaveText('Signed in as ada.');
    await expect(screen.getByText('€20')).toHaveCount(1);
    await expect(screen.getByRole('img', 'Company logo')).toHaveCount(1);
    await expect(screen.getByRole('image', 'Company logo')).toHaveCount(1);
  });

  test('chooses an option by label before text, and waits for a late state', async ({ screen, electron }) => {
    await screen.getByTestId('tier').selectOption('Pro');
    // The second option's label is Pro; the first only has that text, under another label.
    await expect(electron.locator('[data-testid="tier"] option:checked')).not.toHaveAttribute('label', 'Basic');
    await screen.getByTestId('late-check').check();
    await expect(screen.getByTestId('late-check')).toBeChecked();
  });

  test('presses a key on a node that cannot take focus, taps a slotted label, and fails the step after a dialog nothing answers', async ({ screen }) => {
    await screen.getByTestId('key-target').press('Enter');
    await expect(screen.getByTestId('key-result')).toHaveText('Key Enter');
    await screen.getByText('Save', { exact: true }).tap();
    await expect(screen.getByTestId('word-result')).toHaveText('Word button clicked');
    await screen.getByRole('button', 'Ask').tap();
    // The app asked its user something and nothing answered: the next step says so, once.
    const unanswered = await expect(screen.getByTestId('ask-result')).toHaveText('confirm returned false').then(() => undefined, (error: unknown) => error);
    expect(String((unanswered as { cause?: unknown } | undefined)?.cause ?? unanswered)).toMatch(/unhandled confirm dialog: Sure\?; answer it with electron\.onDialog\('accept'\)/);
    await expect(screen.getByTestId('ask-result')).toHaveText('confirm returned false');
  });

  test('answers a dialog as electron.onDialog says, until the handler is removed', async ({ screen, electron }) => {
    const off = await electron.onDialog('accept');
    await screen.getByRole('button', 'Ask').tap();
    await expect(screen.getByTestId('ask-result')).toHaveText('confirm returned true');
    await off();
    const seen: string[] = [];
    await electron.onDialog(async (dialog) => {
      seen.push(`${dialog.type}: ${dialog.message}`);
      await dialog.dismiss();
    });
    await screen.getByRole('button', 'Ask').tap();
    await expect(screen.getByTestId('ask-result')).toHaveText('confirm returned false');
    expect(seen).toEqual(['confirm: Sure?']);
  });

  test('scrolls a list to an item below its edge', async ({ screen }) => {
    const last = screen.getByText('Item 40', { exact: true });
    await last.scrollIntoView();
    await expect(last).toBeVisible();
    await screen.getByRole('list', 'Items').swipe({ direction: 'up' });
    await expect(screen.getByRole('listitem').filter({ hasText: 'Item 1' }).first()).toBeVisible();
  });

  test('starts every test from a fresh launch with empty app data', async ({ screen, electron }) => {
    await expect(screen.getByTestId('username')).toHaveValue('');
    await expect(screen.getByRole('checkbox', 'Remember me')).not.toBeChecked();
    await expect(screen.getByRole('combobox', 'Plan')).toHaveValue('Pro');
    const state = await electron.evaluate(() => (globalThis as unknown as { testbedState: { signIns: unknown[] } }).testbedState);
    expect(state.signIns).toEqual([]);
  });

  test('keeps app data across app.restart() and empties it with app.clearState()', async ({ app, screen }) => {
    await screen.getByTestId('username').fill('ada');
    await screen.getByTestId('password').fill(credentials.user('ada').password);
    await screen.getByRole('checkbox', 'Remember me').check();
    await screen.getByTestId('sign-in').tap();
    await expect(screen.getByTestId('status')).toHaveText(/^Signed in as ada/);
    await app.restart();
    await expect(screen.getByTestId('status')).toHaveText('Welcome back, ada');
    await expect(screen.getByTestId('username')).toHaveValue('ada');
    await app.clearState();
    await expect(screen.getByTestId('status')).toHaveText('Not signed in');
    await expect(screen.getByTestId('username')).toHaveValue('');
  });
});

test.describe('an app that quits on its own', () => {
  test('relaunches with app.restart() and ends the test cleanly', async ({ app, screen, electron }) => {
    await app.open();
    await screen.getByTestId('username').fill('ada');
    await electron.evaluate(({ app: main }) => setTimeout(() => main.quit(), 50));
    await expect.poll(() => electron.windows().length).toBe(0);
    await app.restart();
    await expect(screen.getByTestId('status')).toHaveText('Not signed in');
    await electron.evaluate(({ app: main }) => setTimeout(() => main.quit(), 50));
    await expect.poll(() => electron.windows().length).toBe(0);
  });
});

test.describe('screenshots', () => {
  test.beforeEach(async ({ app }) => {
    await app.open();
  });

  test('paints the password field over and keeps the field beside it', async ({ app, screen, electron }) => {
    const password = screen.getByTestId('password');
    await screen.getByTestId('username').fill('ada');
    await password.fill(credentials.user('ada').password);
    const field = await password.boundingBox();
    const beside = await screen.getByTestId('username').boundingBox();
    expect(field).not.toBeNull();
    expect(beside).not.toBeNull();
    const image = decode(new Uint8Array(readFileSync(await app.screenshot('filled'))));
    // The capture's width over the content's is its scale: the window's own width counts its frame on Windows.
    const { width } = await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getContentBounds());
    const scale = image.width / width;
    expect(blackShare(image, field!, scale)).toBe(1);
    expect(blackShare(image, beside!, scale)).toBeLessThan(0.5);
  });

  test('paints over a password field in a modal dialog, which sits above the rest of the page', async ({ app, screen, electron }) => {
    await screen.getByRole('button', 'Open vault dialog').tap();
    await screen.getByTestId('vault-pin').fill('4321');
    const field = await screen.getByTestId('vault-pin').boundingBox();
    const image = decode(new Uint8Array(readFileSync(await app.screenshot('vault-dialog'))));
    const { width } = await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getContentBounds());
    expect(blackShare(image, field!, image.width / width)).toBe(1);
  });

  test('withholds a screenshot of a window whose password field no mask reaches', async ({ app, screen, electron }) => {
    await electron.waitForWindow(() => screen.getByRole('button', 'Open settings').tap());
    await expect(screen.getByRole('textbox', 'Vault key')).toHaveCount(1);
    const refused = await app.screenshot('vault').then(() => undefined, (error: unknown) => error);
    expect(refused).toMatchObject({ code: 'POLICY_DENIED' });
    // The observation's pixels, what an agent and toHaveScreenshot read, are withheld too.
    const compared = await expect(screen).toHaveScreenshot('vault.png', { timeout: 2000 }).then(() => undefined, (error: unknown) => error);
    expect(compared).toMatchObject({ code: 'POLICY_DENIED' });
  });
});

test.describe('windows', () => {
  test('drives a second window the app opens', async ({ app, screen, electron }) => {
    await app.open();
    const settings = await electron.waitForWindow(() => screen.getByRole('button', 'Open settings').tap());
    expect(await settings.title()).toBe('Settings');
    expect(settings.isActive()).toBe(true);
    await screen.getByRole('switch', 'Dark mode').check();
    await expect(screen.getByTestId('theme')).toHaveText('Theme: dark');
    const [main, second] = electron.windows();
    // The same window is the same object, however a test came by it.
    expect(second).toBe(settings);
    expect(await electron.window({ title: 'Settings' })).toBe(settings);
    expect([await main!.title(), main!.isActive()]).toEqual(['Sign In', false]);
    await main!.activate();
    expect(settings.isActive()).toBe(false);
    await expect(screen.getByTestId('status')).toHaveText('Not signed in');
    const missing = await electron.window({ title: 'Preferences' }, { timeout: 1000 }).then(() => undefined, (error: unknown) => error);
    expect(String(missing)).toContain('no window matches title Preferences; open: "Sign In", "Settings"');
    const none = await electron.waitForWindow(() => Promise.resolve(), { timeout: 500 }).then(() => undefined, (error: unknown) => error);
    expect(none).toMatchObject({ code: 'ACTION_FAILED', message: expect.stringMatching(/no window opened within 500ms/) });
    expect(await electron.evaluate(() => (globalThis as unknown as { testbedState: { settingsOpened: number } }).testbedState.settingsOpened)).toBe(1);
  });

  test('gives a window with no document title the OS window\'s, which is a title it is found by', async ({ app, electron }) => {
    await app.open();
    await electron.evaluate(({ BrowserWindow }) => {
      const untitled = new BrowserWindow({ show: false, title: 'Inspector' });
      untitled.on('page-title-updated', (event) => event.preventDefault());
      void untitled.loadURL('data:text/html,<h1>No title</h1>');
    });
    const untitled = await electron.window({ title: 'Inspector' });
    expect(await untitled.title()).toBe('Inspector');
    expect(await electron.windows()[0]?.title()).toBe('Sign In');
  });

  test('closes a window from its handle, and the one active before it is active again', async ({ app, screen, electron }) => {
    await app.open();
    const settings = await electron.waitForWindow(() => screen.getByRole('button', 'Open settings').tap());
    await settings.close();
    expect(settings.isClosed()).toBe(true);
    expect(electron.windows()).toHaveLength(1);
    expect(electron.windows()[0]?.isActive()).toBe(true);
    await expect(screen.getByTestId('status')).toHaveText('Not signed in');
    expect(await settings.activate().then(() => undefined, (error: unknown) => error)).toMatchObject({ code: 'ACTION_FAILED' });
  });

  test('types into a field inside a closed shadow root', async ({ app, screen, electron }) => {
    await app.open();
    await electron.waitForWindow(() => screen.getByRole('button', 'Open settings').tap());
    const note = screen.getByRole('textbox', 'Vault note');
    await note.pressSequentially('kept');
    await expect(note).toHaveValue('kept');
  });
});

/** A decoded capture: its width, its pixels rows top to bottom, and how many bytes each takes (3 for RGB, 4 for RGBA). */
interface Image {
  readonly width: number;
  readonly pixels: Uint8Array;
  readonly channels: number;
}

function decode(png: Uint8Array): Image {
  const transformer = new Transformer(png);
  const { width, height } = transformer.metadataSync();
  const pixels = transformer.rawPixelsSync();
  return { width, pixels, channels: pixels.length / (width * height) };
}

/** The share of opaque black pixels inside a box given in CSS pixels, a pixel in from each edge so rounding never reaches outside it. */
function blackShare(image: Image, box: { x: number; y: number; width: number; height: number }, scale: number): number {
  const left = Math.ceil(box.x * scale) + 1;
  const top = Math.ceil(box.y * scale) + 1;
  const right = Math.floor((box.x + box.width) * scale) - 1;
  const bottom = Math.floor((box.y + box.height) * scale) - 1;
  let black = 0;
  let total = 0;
  for (let row = top; row < bottom; row += 1) {
    for (let column = left; column < right; column += 1) {
      const at = (row * image.width + column) * image.channels;
      total += 1;
      const opaque = image.channels < 4 || image.pixels[at + 3] === 255;
      if (image.pixels[at] === 0 && image.pixels[at + 1] === 0 && image.pixels[at + 2] === 0 && opaque) black += 1;
    }
  }
  return total === 0 ? 0 : black / total;
}
