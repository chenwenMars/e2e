import { test } from '@e2e-dev/desktop';
import { expect } from 'e2e';
import { frontmost, TESTBED_APP } from './frontmost.ts';

/**
 * The controls window: one test per capability the sign-in form does not
 * reach, all without physical input. The engine launches the app in the
 * background and the app does not activate itself, so these drive an app
 * that is not in front.
 */
test.describe('controls window', () => {
  test.beforeEach(async ({ app, screen, desktop }) => {
    await app.open();
    await desktop.waitForWindow(() => screen.getByRole('button', 'Controls…').tap());
  });

  test('reads the window the trigger opened as the active one, and switches back by title', async ({ screen, desktop }) => {
    const signIn = await desktop.window({ title: /^Sign/ });
    const controls = await desktop.window({ title: 'Controls' });
    expect(await desktop.windows()).toHaveLength(2);
    expect([await controls.isActive(), await signIn.isActive(), await controls.isClosed()]).toEqual([true, false, false]);
    await signIn.activate();
    expect([await controls.isActive(), await signIn.isActive()]).toEqual([false, true]);
    await expect(screen.getByRole('button', 'Sign in')).toBeVisible();
    const missing = await desktop.window({ title: 'Settings' }, { timeout: 500 }).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(String(missing)).toMatch(/no window has the title "Settings"; open: /);
  });

  test('closes the active window, and reads the focused one again', async ({ screen, desktop }) => {
    const controls = await desktop.window({ title: 'Controls' });
    await controls.close();
    expect(await controls.isClosed()).toBe(true);
    const refused = await controls.activate().then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(refused).toMatchObject({ code: 'ACTION_FAILED', message: expect.stringMatching(/the window has closed/) });
    await expect(screen.getByRole('button', 'Sign in')).toBeVisible();
    expect(await desktop.windows()).toHaveLength(1);
  });

  test('types into the focused field through the desktop keyboard', async ({ screen, desktop }) => {
    const note = screen.getByRole('textbox', 'Note');
    await note.focus();
    await desktop.keyboard.type('ada');
    await expect(note).toHaveValue('ada');
  });

  test('scrolls a list until an item shows, and selects it', async ({ screen }) => {
    const last = screen.getByText('Item 40');
    await expect(last).toBeHidden();
    await screen.scrollUntilVisible(last, { direction: 'down' });
    await expect(last).toBeVisible();
    await screen.getByRole('table', 'Items').selectOption('Item 40');
    await expect(screen.getByTestId('controls-status')).toHaveText('Selected Item 40');
  });

  test('finds a row and a cell by the text inside them, and selects a row by tapping its cell', async ({ screen }) => {
    await expect(screen.getByRole('row', 'Item 1')).toBeVisible();
    await expect(screen.getByRole('cell', 'Item 2')).toBeVisible();
    await screen.getByRole('cell', 'Item 2').tap();
    await expect(screen.getByTestId('controls-status')).toHaveText('Selected Item 2');
    // A row takes a tap too: the table selects it, though the row offers no press of its own.
    await screen.getByRole('row', 'Item 3').tap();
    await expect(screen.getByTestId('controls-status')).toHaveText('Selected Item 3');
  });

  test('selects a row of a two-column table by all its text, and refuses a label two rows show', async ({ screen }) => {
    const accounts = screen.getByRole('table', 'Accounts');
    await accounts.selectOption('Checking USD');
    await expect(screen.getByTestId('controls-status')).toHaveText('Selected account 1: Checking USD');
    const refused = await accounts.selectOption('Savings EUR', { timeout: 1_000 }).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(String(refused)).toMatch(/more than one option/);
    // Neither alike row was chosen: the status still shows the first choice.
    await expect(screen.getByTestId('controls-status')).toHaveText('Selected account 1: Checking USD');
  });

  test("keeps a content button with the close-button subrole, and leaves out the window's own title-bar buttons", async ({ screen }) => {
    await expect(screen.getByTestId('close-tab')).toBeVisible();
    // The window names its title-bar buttons, and only those are window chrome: none of them is read as a button.
    await expect(screen.getByRole('button', 'Close')).toHaveCount(0);
    await expect(screen.getByRole('button', 'Minimize')).toHaveCount(0);
  });

  test('presses keys into a field of an app in the background, and types into it', async ({ screen }) => {
    // The keys go into the app's own event queue: it must not be the app in front, before or after.
    expect(frontmost()).not.toBe(TESTBED_APP);
    const note = screen.getByRole('textbox', 'Note');
    await note.fill('hello');
    await note.press('Enter');
    await expect(screen.getByTestId('controls-status')).toHaveText('Submitted: hello');
    // Return can leave the text selected, so a second entry starts from an empty field and is checked whole.
    await note.clear();
    await note.pressSequentially('typed');
    await note.press('Enter');
    await expect(screen.getByTestId('controls-status')).toHaveText('Submitted: typed');
    expect(frontmost()).not.toBe(TESTBED_APP);
  });

  test('presses a key into a look-alike field that grows as it takes the keyboard', async ({ screen }) => {
    // Nothing names the two Tag fields apart, and the press focuses the first, which makes it wider than it was read.
    const tag = screen.getByRole('textbox', 'Tag').first();
    await tag.press('x');
    await expect(tag).toHaveValue('x');
    await tag.press('Enter');
    await expect(screen.getByTestId('controls-status')).toHaveText('Submitted: x');
  });

  test('sends no key to a field that gave the keyboard away as it was focused', async ({ screen }) => {
    // The field hands focus to Note: the key must not follow it there.
    const refused = await screen
      .getByRole('textbox', 'Hands off')
      .press('x')
      .then(
        () => undefined,
        (cause: unknown) => cause,
      );
    expect(String(refused)).toMatch(/did not take keyboard focus|lost keyboard focus/);
    await expect(screen.getByRole('textbox', 'Note')).toHaveValue('');
  });

  test('stops typing when a key opens another window, so the rest of the text does not follow the keyboard there', async ({ screen, desktop }) => {
    const opener = screen.getByRole('textbox', 'Opener');
    // The first character opens the Popup window and moves the keyboard into its field.
    const failure = await opener.pressSequentially('xyz').then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(String(failure)).toMatch(/typing stopped/);
    await expect(opener).toHaveValue('x');
    const popup = await desktop.window({ title: 'Popup' });
    await popup.activate();
    await expect(screen.getByRole('textbox', 'Popup field')).toHaveValue('');
  });

  test('stops typing when a key after a Tab opens another window', async ({ screen, desktop }) => {
    // The Tab takes the keyboard from the Note to the Opener, whose first character opens the Popup.
    const failure = await screen
      .getByRole('textbox', 'Note')
      .pressSequentially('ab\txyz')
      .then(
        () => undefined,
        (cause: unknown) => cause,
      );
    expect(String(failure)).toMatch(/typing stopped/);
    await expect(screen.getByRole('textbox', 'Opener')).toHaveValue('x');
    const popup = await desktop.window({ title: 'Popup' });
    await popup.activate();
    await expect(screen.getByRole('textbox', 'Popup field')).toHaveValue('');
  });

  test('reads native tabs as tabs, the active one selected, and switches between them', async ({ screen }) => {
    const first = screen.getByRole('tab', 'First');
    const second = screen.getByRole('tab', 'Second');
    await expect(first).toBeSelected();
    await expect(second).not.toBeSelected();
    await second.tap();
    await expect(second).toBeSelected();
    await expect(first).not.toBeSelected();
    // A tab list selects by label too, and checks the tab shows it is selected.
    await screen.getByRole('tablist').selectOption('First');
    await expect(first).toBeSelected();
  });

  test('types text whose characters take two UTF-16 units each, whole', async ({ screen }) => {
    const note = screen.getByRole('textbox', 'Note');
    // One key event per character, a surrogate pair in one. AppKit would rejoin a split pair, so this checks such text
    // types whole, not how the driver cuts it, which its unit tests cover.
    const text = '123456789012345😀 café 👍🏽';
    await note.pressSequentially(text);
    await expect(note).toHaveValue(text);
  });

  test('opens a context menu and chooses one of its items', async ({ screen }) => {
    await screen.getByRole('button', 'Options').secondaryTap();
    await expect(screen.getByTestId('controls-status')).toHaveText('Context menu opened');
    await screen.getByRole('menuitem', 'Copy').tap();
    await expect(screen.getByTestId('controls-status')).toHaveText('Chose Copy');
  });

  test('sets a slider and reads a disabled button', async ({ screen }) => {
    await screen.getByRole('slider', 'Volume').fill('40');
    await expect(screen.getByRole('slider', 'Volume')).toHaveValue('40');
    // A value set through accessibility does not always fire the control's action: the status line shows the app saw it.
    await expect(screen.getByTestId('controls-status')).toHaveText('Volume 40');
    await expect(screen.getByRole('button', 'Disabled')).toBeDisabled();
    // AppKit acknowledges a press on a disabled button and ignores it: the tap waits for it to be enabled, then fails.
    const refused = await screen
      .getByRole('button', 'Disabled')
      .tap({ timeout: 1_000 })
      .then(
        () => undefined,
        (cause: unknown) => cause,
      );
    expect(String(refused)).toMatch(/disabled/);
  });

  for (const [button, effect] of [
    ['Cancel', 'Kept the draft'],
    ['Delete', 'Deleted the draft'],
  ] as const) {
    test(`taps ${button} in a SwiftUI alert, which closes it`, async ({ screen }) => {
      await screen.getByRole('button', 'Delete draft…').tap();
      await expect(screen.getByText('Delete draft?')).toBeVisible();
      // SwiftUI answers the press with an error once it closed the alert: the tap still passes, as it landed.
      await screen.getByRole('button', button).tap();
      await expect(screen.getByTestId('controls-status')).toHaveText(effect);
      await expect(screen.getByText('Delete draft?')).toBeHidden();
    });
  }

  test('waits for a disabled list to be enabled before it selects an option', async ({ screen }) => {
    await expect(screen.getByRole('combobox', 'Size')).toBeDisabled();
    // The app enables the list half a second after this tap: the select starts while it is still disabled.
    await screen.getByRole('button', 'Enable later').tap();
    await screen.getByRole('combobox', 'Size').selectOption('Large');
    await expect(screen.getByRole('combobox', 'Size')).toHaveValue('Large');
  });

  test('waits for a disabled box to be enabled before it checks it', async ({ screen }) => {
    await expect(screen.getByRole('checkbox', 'Agree')).toBeDisabled();
    await screen.getByRole('button', 'Enable later').tap();
    await screen.getByRole('checkbox', 'Agree').check();
    await expect(screen.getByRole('checkbox', 'Agree')).toBeChecked();
  });
});
