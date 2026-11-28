import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { failure } from './support.ts';

test.describe('order history', () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/e/order-history');
  });

  test('overview and settings render their panels', async ({ screen }) => {
    await expect(screen.getByTestId('overview-panel')).toContainText('Welcome back, Alex');
    await screen.getByRole('button', 'Settings').tap();
    await expect(screen.getByTestId('overview-panel')).toBeHidden();
    await expect(screen.getByTestId('settings-panel')).toContainText('Email: alex@example.com');
    await screen.getByRole('button', 'Overview').tap();
    await expect(screen.getByTestId('overview-panel')).toContainText(
      'You have 3 orders and 1 active subscription.',
    );
  });

  test('the orders tab never leaves its loading state (planted bug)', async ({ screen }) => {
    await screen.getByRole('button', 'Orders').tap();
    const orders = screen.getByTestId('orders-panel');
    const loader = orders.getByText('Loading your orders...');
    await expect(loader).toBeVisible();
    // Stuck, not slow: a second later the loader is still up and no order came.
    expect(await failure(() => expect(loader).toBeHidden({ timeout: 1000 }))).toHaveProperty(
      'code',
      'ASSERTION_FAILED',
    );
    await expect(orders.getByRole('listitem')).toHaveCount(0);

    await screen.getByRole('button', 'Settings').tap();
    await expect(screen.getByTestId('settings-panel')).toBeVisible();
    await screen.getByRole('button', 'Orders').tap();
    await expect(orders).toHaveText('Loading your orders...');
  });
});
