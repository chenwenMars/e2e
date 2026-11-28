import { launch } from '@e2e-dev/core';
import { createAgent } from '@e2e-dev/core/agent';
import { web } from '@e2e-dev/web/engine';
import { gateway } from 'ai';
import { z } from 'zod';

await using shop = await launch(web(), { app: { url: 'https://shop.example.com' } });
await using session = await shop.newSession();
await session.app.open('/products/A-1001');

const agent = createAgent(session, {
  model: gateway('anthropic/claude-sonnet-5-5'),
  cache: { dir: '.shop-bot/cache' },
});

await agent.act('Add the item to the cart and apply the coupon with the largest discount', {
  cacheKey: 'cart-best-coupon',
});
// A check after the step lets the cache keep its recording.
await session.screen.getByRole('button', /pay now/i).waitFor();

const order = await agent.extract('the order total', { schema: z.object({ total: z.number() }) });
if (order.total <= 39_000) {
  try {
    await session.screen.getByRole('button', /pay now/i).tap();
  } catch (error) {
    // A failed tap may still have reached the server:
    // check the order list, never retry the payment.
    console.error('check /my/orders');
    throw error;
  }
} else {
  console.log(`the total, ${order.total}, is over the limit: the order stays unpaid`);
}
