import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { login } from '../test-support/login.ts';

test('供应商新增、刷新查询、编辑与删除', async ({ app, screen, browser }) => {
  await login(app, screen);
  await screen.getByRole('link', '供应商名录').click();
  await screen.getByRole('button', '新增供应商').click();
  await screen.getByRole('textbox', '供应商名称').fill('测试办公供应商');
  await screen.getByRole('textbox', '联系人').fill('王明');
  await screen.getByRole('textbox', '联系电话').fill('13800138000');
  await screen.getByRole('textbox', '邮箱').fill('test@example.com');
  await screen.getByRole('textbox', '地址').fill('上海市测试路 1 号');
  await screen.getByRole('button', '保存供应商').click();
  const row = screen.getByRole('row', /测试办公供应商/);
  await expect(row).toContainText('王明');
  await browser.reload();
  await screen.getByRole('textbox', '搜索供应商').fill('测试办公');
  await expect(row).toContainText('王明');
  await row.getByRole('button', '编辑').click();
  await screen.getByRole('textbox', '联系人').fill('李华');
  await screen.getByRole('button', '保存供应商').click();
  await expect(row).toContainText('李华');
  await row.getByRole('button', '删除').click();
  await screen.getByRole('button', '确认删除').click();
  await expect(row).not.toBeVisible();
  await browser.reload();
  await screen.getByRole('textbox', '搜索供应商').fill('测试办公');
  await expect(screen.getByText('没有匹配的供应商')).toBeVisible();
});

test('被申请引用的供应商不能删除', async ({ app, screen }) => {
  await login(app, screen);
  await screen.getByRole('link', '供应商名录').click();
  const row = screen.getByRole('row', /青禾办公用品/);
  await row.getByRole('button', '删除').click();
  await screen.getByRole('button', '确认删除').click();
  await expect(screen.getByRole('alert')).toContainText('供应商已被采购申请引用，请改为停用');
  await screen.getByRole('button', '取消').click();
  await expect(row).toBeVisible();
});

test('供应商关联详情与无效资料校验', async ({ app, screen }) => {
  await login(app, screen);
  await screen.getByRole('link', '供应商名录').click();
  const row = screen.getByRole('row', /青禾办公用品/);
  await row.getByRole('button', '详情').click();
  await expect(screen.getByRole('heading', /关联采购申请/)).toBeVisible();
  await expect(screen.getByRole('button', '会议室协作设备')).toBeVisible();
  await screen.getByRole('button', '会议室协作设备').click();
  await expect(screen.getByRole('heading', '编辑采购草稿')).toBeVisible();
  await screen.getByRole('link', '供应商名录').click();
  await screen.getByRole('button', '新增供应商').click();
  await screen.getByRole('button', '保存供应商').click();
  await expect(screen.getByRole('dialog', '新增供应商').getByRole('alert')).toContainText('请填写');
  await screen.getByRole('button', '取消').click();
  await expect(row).toBeVisible();
});
