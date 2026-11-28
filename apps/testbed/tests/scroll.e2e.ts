import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test.describe('scrolling', { platforms: ['web'], tags: ['scroll'] }, () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/scroll');
  });

  test('scrollUntilVisible pages the viewport until a row far down renders', async ({ screen }) => {
    const row = screen.getByRole('button', { name: 'Row 100', exact: true });
    await expect(row).toHaveCount(0);

    await screen.scrollUntilVisible(row);
    await expect(screen.getByRole('status', 'Scroll position')).not.toHaveText('0');
    await row.tap();
    await expect(screen.getByRole('status', 'Picked row')).toHaveText('picked Row 100');
  });

  test('scrollUntilVisible on a node pages that node and leaves the page where it was', async ({ screen }) => {
    const pane = screen.getByRole('list', 'Pane');
    const item = screen.getByRole('button', { name: 'Item 40', exact: true });
    await expect(item).toHaveCount(0);

    await pane.scrollUntilVisible(item);
    await expect(screen.getByRole('status', 'Pane position')).not.toHaveText('0');
    await expect(screen.getByRole('status', 'Scroll position')).toHaveText('0');
    await item.tap();
    await expect(screen.getByRole('status', 'Picked row')).toHaveText('picked Item 40');
  });

  test('a viewport swipe and a wheel gesture both move the page', async ({ screen, browser }) => {
    const position = screen.getByRole('status', 'Scroll position');
    await expect(position).toHaveText('0');

    await screen.swipe({ direction: 'down' });
    await expect(position).not.toHaveText('0');
    const afterSwipe = Number(await position.textContent());
    expect(afterSwipe).toBeGreaterThan(0);

    await browser.mouse.wheel(0, 600);
    await expect(position).toHaveText(String(afterSwipe + 600));

    await screen.swipe({ direction: 'up' });
    await expect.poll(async () => Number(await position.textContent())).toBeLessThan(afterSwipe + 600);
  });

  // The Pane sits under the viewport's center: the screen still scrolls the page.
  test('scrollTo jumps the page to its bottom and back to its top', async ({ screen }) => {
    const position = screen.getByRole('status', 'Scroll position');
    await screen.scrollTo('bottom');
    await expect(position).not.toHaveText('0');
    await screen.getByRole('button', { name: 'Row 120', exact: true }).tap();
    await expect(screen.getByRole('status', 'Picked row')).toHaveText('picked Row 120');
    await expect(screen.getByRole('status', 'Pane position')).toHaveText('0');

    await screen.scrollTo('top');
    await expect(position).toHaveText('0');
  });

  test('scrollTo on a node scrolls that node to its end and leaves the page where it was', async ({ screen }) => {
    await screen.getByRole('list', 'Pane').scrollTo('bottom');
    await expect(screen.getByRole('status', 'Pane position')).not.toHaveText('0');
    await expect(screen.getByRole('status', 'Scroll position')).toHaveText('0');
    await screen.getByRole('button', { name: 'Item 40', exact: true }).tap();
    await expect(screen.getByRole('status', 'Picked row')).toHaveText('picked Item 40');
  });

  test('a node swipe scrolls only inside a scrollable node', async ({ screen }) => {
    await screen.getByRole('list', 'Pane').swipe({ direction: 'down', momentum: 'slow' });
    await expect(screen.getByRole('status', 'Pane position')).not.toHaveText('0');
    await expect(screen.getByRole('status', 'Scroll position')).toHaveText('0');
  });
});
