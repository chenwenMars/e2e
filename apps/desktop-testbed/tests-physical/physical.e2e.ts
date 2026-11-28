import { test } from '@e2e-dev/desktop';
import { expect } from 'e2e';

test.describe('physical input', () => {
  test.beforeEach(async ({ app, screen, desktop }) => {
    await app.open();
    await desktop.waitForWindow(() => screen.getByRole('button', 'Controls…').tap());
  });

  test('double-clicks a control with the real pointer', async ({ screen }) => {
    await screen.getByRole('button', 'Double-click me').doubleTap();
    await expect(screen.getByTestId('controls-status')).toHaveText('Double-clicked');
  });

  test('refuses to double-click a disabled control', async ({ screen }) => {
    // AppKit takes the clicks and ignores them: the gesture waits for the button to be enabled, then fails.
    const refused = await screen
      .getByRole('button', 'Disabled')
      .doubleTap({ timeout: 1_000 })
      .then(
        () => undefined,
        (cause: unknown) => cause,
      );
    expect(String(refused)).toMatch(/disabled/);
  });

  test('hovers a view with the real pointer', async ({ screen }) => {
    await screen.getByTestId('hover').hover();
    await expect(screen.getByTestId('hover-status')).toHaveText('Hovered');
  });

  test('presses a key into a field of a window another holds the keyboard from', async ({ screen, desktop }) => {
    // The Controls window holds the keyboard; the Sign In window is made active, and the press must bring it forward first.
    const signIn = await desktop.window({ title: 'Sign In' });
    await signIn.activate();
    await screen.getByTestId('username').press('x');
    await expect(screen.getByTestId('username')).toHaveValue('x');
  });

  test('taps a point in the window and types through the real keyboard', async ({ screen }) => {
    const note = screen.getByRole('textbox', 'Note');
    const box = await note.boundingBox();
    expect(box).not.toBeNull();
    await screen.tapAt({ x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 });
    // The tap put focus in the field: typing below would focus it by itself, and pass whether the tap landed or not.
    await expect(note).toBeFocused();
    await note.pressSequentially('by hand');
    await note.press('Enter');
    await expect(screen.getByTestId('controls-status')).toHaveText('Submitted: by hand');
  });
});
