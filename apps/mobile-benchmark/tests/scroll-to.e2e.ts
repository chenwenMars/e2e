/**
 * `scrollTo` on the Huge Virtualized List: 600 rows, about 45 screens, of
 * which only those near the viewport are in the tree. Reaching an edge is the
 * only way to see the last row without paging past every one before it.
 */

import { expect, openScenario, test } from './fixtures.ts';

test('screen.scrollTo reaches the last row of the list and comes back to the first', { timeout: 180_000 }, async ({ app, device, screen }) => {
  await openScenario({ app, device, screen }, 'Huge Virtualized List');
  await expect(screen.getByTestId('row-1')).toBeVisible();
  await expect(screen.getByTestId('row-600')).toBeHidden();

  await screen.scrollTo('bottom', { timeout: 90_000 });
  await expect(screen.getByTestId('row-600')).toBeInViewport();
  await expect(screen.getByTestId('row-1')).toBeHidden();

  await screen.scrollTo('top', { timeout: 90_000 });
  await expect(screen.getByTestId('row-1')).toBeInViewport();
  await expect(screen.getByText(/^All 600 rows are loaded/)).toBeVisible();
});

test('locator.scrollTo scrolls the list it names', { timeout: 180_000 }, async ({ app, device, screen }) => {
  await openScenario({ app, device, screen }, 'Huge Virtualized List');
  const list = screen.getByTestId('huge-list');
  await list.scrollTo('bottom', { timeout: 90_000 });
  await expect(screen.getByTestId('row-600')).toBeInViewport();
  // Already there: it resolves after one drag that moves nothing.
  await list.scrollTo('bottom', { timeout: 30_000 });
  await expect(screen.getByTestId('row-600')).toBeInViewport();
});
