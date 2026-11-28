import { test } from '@e2e-dev/electron';
import { credentials, expect } from 'e2e';

test('the agent signs in on the Team plan', async ({ app, agent, screen }) => {
  await app.open();
  await agent.act('sign in with the given credentials on the Team plan, with "Remember me" checked', {
    params: { username: 'ada', password: credentials.user('ada').password },
  });
  await expect(screen.getByTestId('status')).toHaveText('Signed in as ada on Team, remembered (main process saw 7 characters)');
  await agent.assert('the status line says the user is signed in on the Team plan');
});

test('the agent turns on dark mode in the settings window', async ({ app, agent, screen, electron }) => {
  await app.open();
  await agent.act('open the settings window and turn dark mode on');
  await (await electron.window({ title: 'Settings' })).activate();
  await expect(screen.getByTestId('theme')).toHaveText('Theme: dark');
});
