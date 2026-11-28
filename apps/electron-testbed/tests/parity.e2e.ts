import { existsSync, readFileSync, statSync } from 'node:fs';
import { test } from '@e2e-dev/electron';
import { expect } from 'e2e';

test.describe('what an Electron target shares with the web', () => {
  test.beforeEach(async ({ app, electron, screen }) => {
    await app.open();
    await electron.evaluate(() => (globalThis as unknown as { testbedOpen: (page: string) => Promise<void> }).testbedOpen('controls.html'));
    await expect(screen.getByRole('heading', 'Controls')).toBeVisible();
  });

  test('attaches a file from memory, which the page reads by its name and content', async ({ screen }) => {
    await screen.getByTestId('attachment').setInputFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('written in the test') });
    await expect(screen.getByTestId('attachment-count')).toHaveText('1 files');
    await expect(screen.getByTestId('attachment-text')).toHaveText('written in the test');
  });

  test('says whether an element is in the viewport, before and after scrolling to it', async ({ screen }) => {
    await expect(screen.getByRole('heading', 'Controls')).toBeInViewport();
    await expect(screen.getByTestId('far-below')).not.toBeInViewport();
    await screen.getByTestId('far-below').scrollIntoView();
    await expect(screen.getByTestId('far-below')).toBeInViewport();
    await expect(screen.getByRole('heading', 'Controls')).not.toBeInViewport();
  });

  test('goes back to the page the window showed before, and says when there is none', async ({ app, screen }) => {
    await app.back();
    await expect(screen.getByRole('heading', { name: 'Hello from e2e', level: 1 })).toBeVisible();
    const refused = await app.back().then(() => undefined, (error: unknown) => error);
    expect(refused).toMatchObject({ code: 'NOT_ACTIONABLE', message: expect.stringMatching(/no page to go back to/) });
  });

  test('records a video of the window, through a relaunch', async ({ app, screen }) => {
    await app.startRecording({ name: 'relaunch' });
    await screen.getByLabel('Budget').fill('750');
    await app.restart();
    await expect(screen.getByRole('heading', { name: 'Hello from e2e', level: 1 })).toBeVisible();
    const videos = await app.stopRecording();
    expect(videos).toHaveLength(1);
    const [video] = videos;
    if (!('path' in video)) throw new Error('the recording is a link, not a file');
    expect(video.path).toMatch(/recordings[\\/]001-relaunch\.webm$/);
    expect(existsSync(video.path)).toBe(true);
    expect(statSync(video.path).size).toBeGreaterThan(1000);
  });

  test('waits for a download and keeps the file with the attempt, and says when none starts', async ({ screen, electron }) => {
    const file = await electron.waitForDownload(() => screen.getByRole('link', 'Download note').tap());
    expect(file.suggestedFilename).toBe('note.txt');
    expect(file.path).toMatch(/^downloads\/\d+-note\.txt$/);
    expect(readFileSync(file.absolutePath, 'utf8')).toBe('downloaded note');
    const none = await electron.waitForDownload(() => Promise.resolve(), { timeout: 500 }).then(() => undefined, (error: unknown) => error);
    expect(none).toMatchObject({ code: 'ACTION_FAILED', message: expect.stringMatching(/no download finished/) });
  });

  test('refuses a tap on a link another element covers, though both sit in a checkbox label', async ({ screen }) => {
    const refused = await screen.getByTestId('more-info').tap({ timeout: 800 }).then(() => undefined, (error: unknown) => error);
    expect(refused).toMatchObject({ code: 'ACTION_FAILED' });
    await expect(screen.getByTestId('chosen')).not.toBeChecked();
    await expect(screen.getByTestId('more-clicks')).toHaveText('0');
    // The label still presses the checkbox it names.
    await screen.getByTestId('chosen').check();
    await expect(screen.getByTestId('chosen')).toBeChecked();
  });

  test('clears a file through the chooser a button opens', async ({ screen }) => {
    await screen.getByTestId('upload-button').setInputFiles('app/settings.html');
    await expect(screen.getByTestId('picked-name')).toHaveText('settings.html');
    await screen.getByTestId('upload-button').setInputFiles([]);
    await expect(screen.getByTestId('picked-name')).toHaveText('No file');
  });

  test('refuses a tap on a button whose shadow host is aria-disabled', async ({ screen }) => {
    const button = screen.getByRole('button', 'Hosted action');
    await expect(button).toBeDisabled();
    expect(await button.tap({ timeout: 800 }).then(() => undefined, (error: unknown) => error)).toMatchObject({ code: 'ACTION_FAILED' });
    await expect(screen.getByTestId('host-clicks')).toHaveText('0');
  });

  test('reads the native state of a control the accessibility tree leaves out', async ({ screen }) => {
    const hidden = screen.getByTestId('hidden-check');
    await expect(hidden).toBeDisabled();
    await expect(hidden).toBeChecked();
    await expect(hidden).not.toBeEnabled();
  });

  test('refuses to fill a read-only editor and to choose in an inert select', async ({ screen }) => {
    const editor = screen.getByTestId('locked-editor');
    await expect(editor).not.toBeEditable();
    expect(await editor.fill('New', { timeout: 800 }).then(() => undefined, (error: unknown) => error)).toMatchObject({ code: 'ACTION_FAILED' });
    await expect(editor).toHaveText('Original');
    const choice = screen.getByTestId('inert-select');
    expect(await choice.selectOption('Second', { timeout: 800 }).then(() => undefined, (error: unknown) => error)).toMatchObject({ code: 'ACTION_FAILED' });
    await expect(choice).toHaveValue('First');
  });

  test('reads a select\'s value as the app does when its option has no value attribute', async ({ screen }) => {
    const place = screen.getByTestId('place');
    expect(await place.inputValue()).toBe('City Center');
    await place.selectOption({ index: 1 });
    expect(await place.inputValue()).toBe('New\u00a0York');
  });

  test('captures a window the app keeps hidden', async ({ app, electron }) => {
    await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.hide());
    expect(statSync(await app.screenshot('hidden')).size).toBeGreaterThan(1000);
  });
});
