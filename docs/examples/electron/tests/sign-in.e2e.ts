import { test } from '@e2e-dev/electron';
import { credentials, expect } from 'e2e';

test('signs in and opens settings', async ({ app, screen, electron }) => {
  const ada = credentials.user('ada');
  await app.open();
  await screen.getByRole('textbox', 'Username').fill(ada.username);
  await screen.getByRole('textbox', 'Password').fill(ada.password);
  await screen.getByRole('button', 'Sign in').tap();
  await expect(screen.getByTestId('status')).toContainText('Signed in as ada');

  await electron.waitForWindow(() => screen.getByRole('button', 'Open settings').tap());
  await expect(screen.getByRole('heading', 'Settings')).toBeVisible();

  const userData = await electron.evaluate(({ app: main }) => main.getPath('userData'));
  expect(userData).toContain('e2e-electron-');
});
