import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('app opens', async ({ app, browser }) => {
  const response=await fetch(`${app.baseUrl}/api/procurement/storage`);
  assert.ok(response.ok);
  const info=await response.json();
  assert.equal(info.directory,resolve(process.env.PROCUREMENT_DATA_DIR ?? '.data'));
  await app.open('/');
  await expect(browser.locator('body')).toBeVisible();
});

test('数据管理模块和迁移接口已移除', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByLabel('账号').fill('admin');
  await screen.getByLabel('密码').fill('admin');
  await screen.getByRole('button', '登录').click();
  await expect(screen.getByRole('heading', '工作首页')).toBeVisible();
  await expect(screen.getByRole('navigation', '主导航')).toBeVisible();
  await expect(screen.getByRole('link', '迁移浏览器数据')).not.toBeVisible();
  await expect(screen.getByText('数据管理')).not.toBeVisible();
  for(const path of ['import','import/preview']) {
    const response=await fetch(`${app.baseUrl}/api/procurement/${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    assert.equal(response.status,404);
  }
});
