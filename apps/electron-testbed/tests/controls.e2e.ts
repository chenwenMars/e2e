import { existsSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from '@e2e-dev/electron';
import { credentials, expect } from 'e2e';

/** What a rejected step threw, for checking its code. */
function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => undefined, (error: unknown) => error);
}

test.describe('controls page', () => {
  test.beforeEach(async ({ app, electron, screen }) => {
    await app.open();
    await electron.evaluate(() => (globalThis as unknown as { testbedOpen: (page: string) => Promise<void> }).testbedOpen('controls.html'));
    await expect(screen.getByRole('heading', 'Controls')).toBeVisible();
  });

  test('fills a range past its default bounds, an input of an unknown type, and pickers as web() does', async ({ screen }) => {
    await screen.getByLabel('Budget').fill('750');
    await expect(screen.getByTestId('budget')).toHaveValue('750');
    await screen.getByRole('textbox', 'Nickname').fill('Ace');
    await expect(screen.getByTestId('nickname')).toHaveValue('Ace');
    await screen.getByTestId('tint').fill('#FF8800');
    await expect(screen.getByTestId('tint')).toHaveValue('#ff8800');
    await screen.getByTestId('birthday').fill(' 2026-01-02 ');
    await expect(screen.getByTestId('birthday')).toHaveValue('2026-01-02');
    await expect(screen.getByRole('textbox', 'Birthday')).toHaveCount(1);
    // The field order follows the OS locale, so the typed digits are checked only for landing in the field.
    await screen.getByTestId('birthday').clear();
    await screen.getByTestId('birthday').pressSequentially('05172026');
    await expect(screen.getByTestId('birthday')).not.toHaveValue('');
  });

  test('shows the agent an editing host with no role as a text field, which a role query does not find, as on the web', async ({ screen }) => {
    expect(await screen.tree()).toMatch(/textbox[^\n]*Bare editor text/);
    await expect(screen.getByTestId('bare-editor')).not.toHaveRole('textbox');
  });

  test('reads a heading tag\'s level over its aria-level, and a progress element\'s value', async ({ screen }) => {
    await expect(screen.getByRole('heading', { name: 'Levels', level: 2 })).toHaveCount(1);
    await expect(screen.getByRole('progressbar', 'Sync')).toHaveValue('70');
  });

  test('clears a field with a Delete key an editor sees, and focuses nothing on an element that takes no focus', async ({ screen }) => {
    await screen.getByTestId('tracked').clear();
    await expect(screen.getByTestId('tracked')).toHaveValue('');
    await expect(screen.getByTestId('tracked-event')).toHaveText('deleteContentForward');
    await screen.getByRole('heading', 'Levels').focus();
  });

  test('leaves prefers-color-scheme to the app\'s nativeTheme', async ({ screen, electron }) => {
    await electron.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = 'dark';
    });
    await expect(screen.getByTestId('scheme')).toHaveText('dark');
  });

  test('checks a mixed checkbox and refuses to uncheck a radio at once', async ({ screen }) => {
    await screen.getByRole('checkbox', 'Some files').check();
    await expect(screen.getByRole('checkbox', 'Some files')).toBeChecked();
    const started = Date.now();
    const refused = await failure(screen.getByRole('radio', 'Free').uncheck({ timeout: 5000 }));
    expect(refused).toMatchObject({ code: 'ACTION_FAILED', message: expect.stringContaining('select another radio') });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('clears a file input with no files and refuses two files where one fits', async ({ screen }) => {
    await screen.getByTestId('attachment').setInputFiles('app/settings.html');
    await expect(screen.getByTestId('attachment-count')).toHaveText('1 files');
    await screen.getByTestId('attachment').setInputFiles([]);
    await expect(screen.getByTestId('attachment-count')).toHaveText('0 files');
    const refused = await failure(screen.getByTestId('attachment').setInputFiles(['app/settings.html', 'app/settings.html']));
    expect(refused).toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  test('chooses an option by its label only when it has a label attribute, and refuses a select no one can see', async ({ screen }) => {
    await screen.getByTestId('size').selectOption('Extra large');
    await expect(screen.getByTestId('size')).toHaveValue('xl');
    expect(await failure(screen.getByTestId('size').selectOption('XL', { timeout: 1000 }))).toMatchObject({ code: 'ACTION_FAILED' });
    expect(await failure(screen.getByTestId('folded-select').selectOption('B', { timeout: 1000 }))).toMatchObject({ code: 'ACTION_FAILED' });
  });

  test('reads table cells apart, text as rendered, the label of a closed select\'s option, and visibility as web() does', async ({ screen, electron }) => {
    await expect(screen.getByTestId('ada-row')).toHaveText('Ada 36');
    await expect(screen.getByText('SHOUTY TEXT')).toHaveText('SHOUTY TEXT');
    await expect(electron.locator('[data-testid="size"] option[value="s"]')).toHaveText('Small');
    await expect(screen.getByTestId('invisible')).toBeHidden();
    await expect(electron.locator('[data-testid="invisible"]')).toBeHidden();
  });

  test('refuses to scroll to an element that is not rendered, and an invalid selector as a locator error', async ({ screen, electron }) => {
    expect(await failure(screen.getByTestId('not-rendered').scrollIntoView({ timeout: 1000 }))).toMatchObject({ code: 'ACTION_FAILED' });
    expect(await failure(electron.locator('div[[').count())).toMatchObject({ code: 'INVALID_LOCATOR' });
  });

  test('taps a button the app renders anew while the tap waits', async ({ screen }) => {
    await screen.getByRole('button', 'Start re-render').tap();
    await screen.getByRole('button', 'Save draft').tap({ timeout: 5000 });
    await expect(screen.getByTestId('draft-status')).toHaveText('Saved');
  });

  test('taps a button a sticky header covers', async ({ screen }) => {
    await screen.getByRole('button', 'Scroll the target under the header').tap();
    await screen.getByRole('button', 'Behind the header').tap({ timeout: 5000 });
    await expect(screen.getByTestId('under-header-status')).toHaveText('Tapped');
  });

  test('checks a checkbox its label draws, and finds text by text alone, as web() does', async ({ screen }) => {
    // The input has no box: it reads as shown because its label is, and the click goes to the label.
    const drawn = screen.getByRole('checkbox', 'Drawn by its label');
    await expect(drawn).toBeVisible();
    await drawn.check();
    await expect(drawn).toBeChecked();
    // Chromium leaves this label's text out of its tree; a tap on it toggles the checkbox.
    await screen.getByText('Drawn by its label').tap();
    await expect(drawn).not.toBeChecked();
    // The field a label names is no second match for the label's words.
    await expect(screen.getByText('Tracked')).toHaveCount(1);
    // A text query scoped to the element that holds the text finds it.
    await expect(screen.getByTestId('toast').getByText('Saved draft')).toHaveCount(1);
  });

  test('reads ARIA values, read-only states, and levels as written, as web() does', async ({ screen }) => {
    await expect(screen.getByRole('slider', 'Volume')).toHaveValue('Low');
    await expect(screen.getByRole('slider', 'Volume')).not.toBeEditable();
    await expect(screen.getByRole('progressbar', 'Upload')).toHaveValue('40');
    await expect(screen.getByRole('treeitem', { name: 'src', level: 1 })).toHaveCount(1);
  });

  test('types into a focused listbox as typeahead, refuses to check a toggle button, and hovers a focusable span', async ({ screen }) => {
    await screen.getByRole('listbox', 'Planet').pressSequentially('v');
    await expect(screen.getByRole('option', 'Venus')).toBeSelected();
    expect(await failure(screen.getByRole('button', 'Italic').check({ timeout: 1000 }))).toMatchObject({ code: 'ACTION_FAILED' });
    await screen.getByText('Hover for tip').hover();
    await expect(screen.getByTestId('tip')).toHaveText('Tip shown');
  });

  test('saves a download in the attempt\'s own directory, never the user\'s', async ({ screen, electron }) => {
    const downloads = await electron.evaluate(({ app: main }) => main.getPath('downloads'));
    const userData = await electron.evaluate(({ app: main }) => main.getPath('userData'));
    expect(realpathSync(path.dirname(downloads))).toBe(realpathSync(userData));
    await screen.getByRole('link', 'Download note').tap();
    await expect.poll(() => existsSync(path.join(downloads, 'note.txt'))).toBe(true);
  });

  test('finds text that inline markup splits, and text under aria-hidden, as web() does', async ({ screen }) => {
    await expect(screen.getByText('Order ABC123', { exact: true })).toHaveCount(1);
    await expect(screen.getByText('Order ABC123')).toHaveCount(1);
    await expect(screen.getByText('ABC123', { exact: true })).toHaveCount(1);
    await expect(screen.getByText('Ref R77', { exact: true })).toHaveCount(1);
    await expect(screen.getByText('Unlisted directions', { exact: true })).toHaveCount(1);
  });

  test('checks a box its app replaces, unchecks a custom radio, and refuses to fill a field no user reaches', async ({ screen }) => {
    await screen.getByTestId('replace-box').check();
    await expect(screen.getByText('Saved', { exact: true })).toBeVisible();
    await screen.getByTestId('aria-radio').uncheck();
    await expect(screen.getByTestId('aria-radio')).toHaveAttribute('aria-checked', 'false');
    const hidden = await failure(screen.getByTestId('hidden-date').fill('2026-01-01', { timeout: 500 }));
    expect(hidden).toMatchObject({ cause: { message: expect.stringMatching(/it is not visible/) } });
    await expect(screen.getByTestId('hidden-date')).toHaveValue('');
  });

  test('gives files to the chooser a button opens', async ({ screen }) => {
    await screen.getByTestId('upload-button').setInputFiles('app/settings.html');
    await expect(screen.getByTestId('picked-name')).toHaveText('settings.html');
    // A button that opens no chooser is no place for a file.
    const refused = await failure(screen.getByRole('button', 'Hold').setInputFiles('app/settings.html', { timeout: 500 }));
    expect(refused).toMatchObject({ cause: { message: expect.stringMatching(/opened no file chooser/) } });
  });

  test('withholds a window that left the app for a local file from screenshots and observations', async ({ app, screen, electron }) => {
    const outside = path.join(tmpdir(), `e2e-electron-outside-${process.pid}.txt`);
    writeFileSync(outside, 'outside the app');
    try {
      await electron.evaluate(({ BrowserWindow }, file) => BrowserWindow.getAllWindows()[0]?.loadFile(file), outside);
      // A test's own locator still reads what its app shows.
      await expect(screen.getByText('outside the app')).toBeVisible();
      const refused = await failure(app.screenshot('outside'));
      expect(refused).toMatchObject({ code: 'POLICY_DENIED' });
      expect(String(refused)).toMatch(/left the app's directory/);
    } finally {
      rmSync(outside, { force: true });
    }
  });

  test('drags a draggable element onto a drop target, with the data its dragstart set', async ({ screen }) => {
    await screen.getByRole('button', 'Card to move').dragTo(screen.getByRole('region', 'Tray'));
    await expect(screen.getByTestId('tray-status')).toHaveText('Tray holds card');
    // The drag ended with the drop: the pointer is free for the next action.
    await screen.getByRole('button', 'Hold').tap();
    await expect(screen.getByTestId('hold-state')).toHaveText('up');
  });

  test('releases a long press its timeout cuts short before the step fails', async ({ screen }) => {
    const cut = await failure(screen.getByRole('button', 'Hold').longPress({ duration: 3000, timeout: 1000 }));
    expect((cut as { cause?: { code?: string } }).cause?.code).toBe('ACTION_MAY_HAVE_COMMITTED');
    await expect(screen.getByTestId('hold-state')).toHaveText('up', { timeout: 100 });
  });

  test('refuses a secret as electron.evaluate\'s argument', async ({ electron }) => {
    const refused = await failure(electron.evaluate((_main, arg: unknown) => JSON.stringify(arg), { password: credentials.user('ada').password }));
    expect(refused).toMatchObject({ code: 'POLICY_DENIED' });
  });

  test('says a window\'s renderer crashed, and reads it again once the app reloads it', async ({ screen, electron }) => {
    await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.forcefullyCrashRenderer());
    const crashed = await failure(screen.getByRole('heading', 'Controls').waitFor({ timeout: 1000 }));
    expect(crashed).toMatchObject({ code: 'APP_NOT_OPEN', message: expect.stringContaining('renderer crashed') });
    // The crashed window is still one of the app's windows; its document cannot answer, so its title is the OS window's.
    const [crashedWindow] = electron.windows();
    expect(electron.windows()).toHaveLength(1);
    expect(crashedWindow?.isActive()).toBe(true);
    expect(await crashedWindow?.title()).toBe('Controls');
    await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.reload());
    await expect(screen.getByRole('heading', 'Controls')).toBeVisible({ timeout: 5000 });
  });

  test('restarts promptly through a beforeunload guard, and the app runs its quit handlers', async ({ app, screen, electron }) => {
    const userData = await electron.evaluate(({ app: main }) => main.getPath('userData'));
    await screen.getByRole('button', 'Guard unload').tap();
    const started = Date.now();
    await app.restart();
    expect(Date.now() - started).toBeLessThan(4000);
    expect(existsSync(path.join(userData, 'quit-handled'))).toBe(true);
  });
});

test.describe('a shown window that closes', () => {
  test('reads the window shown before it at once, though its close event comes later', async ({ app, screen, electron }) => {
    await app.open();
    await electron.waitForWindow(() => screen.getByRole('button', 'Open settings').tap());
    await expect(screen.getByRole('switch', 'Dark mode')).toBeVisible();
    await electron.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((window) => window.getTitle() === 'Settings')?.destroy();
    });
    await expect(screen.getByTestId('status')).toHaveText('Not signed in', { timeout: 2000 });
  });
});

test.describe('an app that quits on its own', () => {
  test('says so, rather than that it was never opened', async ({ app, screen, electron }) => {
    await app.open();
    await electron.evaluate(({ app: main }) => setTimeout(() => main.quit(), 50));
    await expect.poll(() => electron.windows().length).toBe(0);
    expect(await failure(screen.getByRole('button', 'Sign in').tap({ timeout: 1000 }))).toMatchObject({ code: 'APP_NOT_OPEN', message: expect.stringContaining('quit on its own') });
  });
});

test.describe('the app not running', () => {
  test('a locator says the app is not open rather than waiting out its timeout', async ({ screen }) => {
    const started = Date.now();
    expect(await failure(screen.getByRole('button', 'Sign in').tap({ timeout: 5000 }))).toMatchObject({ code: 'APP_NOT_OPEN' });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
