import { test } from '@e2e-dev/desktop';
import { readFileSync } from 'node:fs';
import { Transformer } from '@napi-rs/image';
import { credentials, expect } from 'e2e';

test.describe('sign-in form', () => {
  test.beforeEach(async ({ app }) => {
    await app.open();
  });

  test('signs in with every control set', async ({ screen }) => {
    const ada = credentials.user('ada');
    await expect(screen.getByText('Not signed in')).toBeVisible();
    await screen.getByRole('textbox', 'Username').fill(ada.username);
    await screen.getByRole('textbox', 'Password').fill(ada.password);
    await screen.getByRole('checkbox', 'Remember me').check();
    await expect(screen.getByRole('checkbox', 'Remember me')).toBeChecked();
    await screen.getByRole('combobox', 'Plan').selectOption('Team');
    await expect(screen.getByRole('combobox', 'Plan')).toHaveValue('Team');
    await screen.getByRole('button', 'Sign in').tap();
    await expect(screen.getByTestId('status')).toHaveText('Signed in as ada on Team, remembered (password: 7 characters)');
  });

  test('selects an option of a pop-up whose menu a tap already opened', async ({ screen }) => {
    const plan = screen.getByRole('combobox', 'Plan');
    await plan.tap();
    await expect(screen.getByRole('menuitem', 'Team')).toBeVisible();
    // The open menu is the list: a press to open it again would close it.
    await plan.selectOption('Team');
    await expect(plan).toHaveValue('Team');
    await expect(screen.getByRole('menuitem', 'Team')).toHaveCount(0);
  });

  test('closes a pop-up menu a tap opened when the select asks for the option it already shows', async ({ screen }) => {
    const plan = screen.getByRole('combobox', 'Plan');
    await plan.tap();
    await expect(screen.getByRole('menuitem', 'Pro')).toBeVisible();
    await plan.selectOption('Pro');
    await expect(plan).toHaveValue('Pro');
    await expect(screen.getByRole('menuitem', 'Pro')).toHaveCount(0);
  });

  test('refuses a disabled option of a pop-up as disabled, and closes its menu', async ({ screen }) => {
    const plan = screen.getByRole('combobox', 'Plan');
    const refused = await plan.selectOption('Legacy', { timeout: 1_000 }).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(String(refused)).toMatch(/option "Legacy" is disabled/);
    await expect(plan).toHaveValue('Pro');
    await expect(screen.getByRole('menuitem', 'Legacy')).toHaveCount(0);
  });

  test('chooses the enabled one of two pop-up options of one title', async ({ screen }) => {
    // The Plan menu holds a disabled Enterprise before an enabled one.
    const plan = screen.getByRole('combobox', 'Plan');
    await plan.selectOption('Enterprise');
    await expect(plan).toHaveValue('Enterprise');
  });

  test('types a username with an uppercase letter and a password through key events', async ({ screen }) => {
    // Typing goes key by key, as a person types: a capital takes its key with Shift, and a password field takes keystrokes.
    await screen.getByRole('textbox', 'Username').pressSequentially('Ada');
    await expect(screen.getByRole('textbox', 'Username')).toHaveValue('Ada');
    await screen.getByRole('textbox', 'Password').pressSequentially('testing');
    await screen.getByRole('button', 'Sign in').tap();
    await expect(screen.getByTestId('status')).toHaveText('Signed in as Ada on Pro (password: 7 characters)');
  });

  test('puts the keyboard in the password field when it is tapped', async ({ screen, desktop }) => {
    // AppKit's password field offers a confirm action too: a tap must focus it, so the keys after it go there.
    await screen.getByRole('textbox', 'Username').tap();
    await screen.getByRole('textbox', 'Password').tap();
    await expect(screen.getByRole('textbox', 'Password')).toBeFocused();
    await desktop.keyboard.press('x');
    await expect(screen.getByRole('textbox', 'Username')).toHaveValue('');
    // The key reached the password field: signing in counts one character there.
    await screen.getByRole('button', 'Sign in').tap();
    await expect(screen.getByTestId('status')).toHaveText('Signed in as  on Pro (password: 1 characters)');
  });

  test('reads controls by test id and refuses an empty password', async ({ screen }) => {
    await screen.getByTestId('username').fill('grace');
    await expect(screen.getByTestId('username')).toHaveValue('grace');
    await screen.getByTestId('username').clear();
    await expect(screen.getByTestId('username')).toHaveValue('');
    await screen.getByTestId('sign-in').tap();
    await expect(screen.getByTestId('status')).toHaveText('Password is required');
  });

  test('starts every test from a fresh launch', async ({ screen, desktop }) => {
    expect(desktop.platform).toBe('macos');
    await expect(screen.getByTestId('username')).toHaveValue('');
    await expect(screen.getByRole('checkbox', 'Remember me')).not.toBeChecked();
    await expect(screen.getByRole('combobox', 'Plan')).toHaveValue('Pro');
    const windows = await desktop.windows();
    expect(await Promise.all(windows.map((window) => window.title()))).toEqual(['Sign In']);
  });

  test('takes a screenshot of the window with the password field painted over', async ({ app, screen }) => {
    const password = screen.getByRole('textbox', 'Password');
    await screen.getByRole('textbox', 'Username').fill('ada');
    await password.fill(credentials.user('ada').password);
    const field = await password.boundingBox();
    const beside = await screen.getByRole('textbox', 'Username').boundingBox();
    expect(field).not.toBeNull();
    expect(beside).not.toBeNull();
    const file = await app.screenshot('filled');
    // The window is 420 points wide: the capture's width over that is its scale.
    const image = decode(new Uint8Array(readFileSync(file)));
    const scale = image.width / 420;
    // The password field's own box is painted black, and the username field beside it keeps its pixels.
    expect(blackShare(image, field!, scale)).toBe(1);
    expect(blackShare(image, beside!, scale)).toBeLessThan(0.5);
  });
});

/** A decoded capture: its width and its RGBA pixels, rows top to bottom. */
interface Image {
  readonly width: number;
  readonly pixels: Uint8Array;
}

function decode(png: Uint8Array): Image {
  const transformer = new Transformer(png);
  return { width: transformer.metadataSync().width, pixels: transformer.rawPixelsSync() };
}

/** The share of opaque black pixels inside a box given in window points, a pixel in from each edge so rounding never reaches outside it. */
function blackShare(image: Image, box: { x: number; y: number; width: number; height: number }, scale: number): number {
  const left = Math.ceil(box.x * scale) + 1;
  const top = Math.ceil(box.y * scale) + 1;
  const right = Math.floor((box.x + box.width) * scale) - 1;
  const bottom = Math.floor((box.y + box.height) * scale) - 1;
  let black = 0;
  let total = 0;
  for (let row = top; row < bottom; row += 1) {
    for (let column = left; column < right; column += 1) {
      const at = (row * image.width + column) * 4;
      total += 1;
      if (image.pixels[at] === 0 && image.pixels[at + 1] === 0 && image.pixels[at + 2] === 0 && image.pixels[at + 3] === 255) black += 1;
    }
  }
  return total === 0 ? 0 : black / total;
}
