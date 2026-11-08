import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { login } from '../test-support/login.ts';

/** Read the issued business code from the row actually rendered on screen. */
async function readCode(browser: import('@e2e-dev/web').Browser, title: string) {
    return browser.evaluate((title) => {
        const row = Array.from(document.querySelectorAll('.el-table__body tr')).find(r => r.textContent?.includes(title));
        const code = row?.textContent?.match(/\d{12}/)?.[0];
        if (!code) throw new Error('列表缺少采购编码');
        return code;
    }, title);
}

test('创建采购申请，恢复草稿并提交', async ({ app, screen, browser }) => {
    const title = '扩展坞采购验收';
    const button = (name: string) => screen.getByRole('button', name);
    await login(app, screen);
    await screen.getByRole('link', '采购申请').click();
    await button('创建申请单').click();
    await screen.getByPlaceholder('例如：研发工作站采购').fill(title);
    await screen.getByRole('combobox', /申请部门/).press('Enter');
    await screen.getByRole('option', '研发部').click();
    const date = screen.getByRole('combobox', /期望到货日期/);
    await date.fill('2027-02-01');
    await date.press('Enter');
    await screen.getByRole('textbox', /采购事由/).fill('工位增加显示器接口');
    await button('下一步').click();
    await screen.getByRole('combobox', /供应商/).fill('青禾');
    await screen.getByRole('option', '青禾办公用品').click();
    await screen.getByRole('textbox', '品名 1').fill('USB-C 扩展坞');
    await screen.getByRole('spinbutton', '数量 1').fill('2');
    await screen.getByRole('spinbutton', '单价（元） 1').fill('129.50');
    await screen.getByRole('textbox', /收货地址/).fill('上海市测试园区');
    await screen.getByRole('textbox', /收货联系人/).fill('张三');
    await button('下一步').click();
    await screen.getByRole('textbox', '采购说明').fill('验收时检查双屏输出');
    await browser.locator('input[type=file]').setInputFiles('test-support/quote.txt');
    await button('保存草稿').click();

    const row = screen.getByRole('row', new RegExp(title));
    await expect(row).toContainText('草稿');
    const code = await readCode(browser, title);
    await browser.reload();
    await row.getByRole('button', '继续编辑').click();
    await expect(screen.getByTestId('procurement-code')).toContainText(code);
    await button('下一步').click();
    await expect(screen.getByText('合计 ¥259.00')).toBeVisible();
    await expect(button('下载 quote.txt')).toBeVisible();
    await button('提交申请').click();
    await expect(row).toContainText('已提交');
    assert.equal(await readCode(browser, title), code);
    await row.getByRole('button', '查看详情').click();
    await expect(screen.getByRole('heading', title)).toBeVisible();
    await expect(button('下载 quote.txt')).toBeVisible();
    const download = await browser.waitForDownload(() => button('下载 quote.txt').click());
    assert.equal(await readFile(download.absolutePath, 'utf8'), await readFile('test-support/quote.txt', 'utf8'));
});

test('直接提交采购申请，刷新后仍可在列表搜索并查看详情', async ({ app, screen, browser }) => {
    const title = '本地持久化采购验收';
    const button = (name: string) => screen.getByRole('button', name);
    await login(app, screen);
    await screen.getByRole('link', '采购申请').click();
    await button('创建申请单').click();
    await screen.getByPlaceholder('例如：研发工作站采购').fill(title);
    await screen.getByRole('combobox', /申请部门/).press('Enter');
    await screen.getByRole('option', '研发部').click();
    const date = screen.getByRole('combobox', /期望到货日期/);
    await date.fill('2027-02-01');
    await date.press('Enter');
    await screen.getByRole('textbox', /采购事由/).fill('验证提交后的本地存储和列表查询');
    await button('下一步').click();
    await screen.getByRole('combobox', /供应商/).fill('青禾');
    await screen.getByRole('option', '青禾办公用品').click();
    await screen.getByRole('textbox', '品名 1').fill('USB-C 扩展坞');
    await screen.getByRole('spinbutton', '数量 1').fill('2');
    await screen.getByRole('spinbutton', '单价（元） 1').fill('129.50');
    await screen.getByRole('textbox', /收货地址/).fill('上海市测试园区');
    await screen.getByRole('textbox', /收货联系人/).fill('张三');
    await button('下一步').click();
    await screen.getByRole('textbox', '采购说明').fill('直接提交后刷新检查');
    await browser.locator('input[type=file]').setInputFiles('test-support/quote.txt');
    await button('下一步').click();
    await button('提交申请').click();

    const row = screen.getByRole('row', new RegExp(title));
    await expect(row).toContainText('已提交');
    const code = await readCode(browser, title);
    await expect(row).toContainText('¥259.00');
    await browser.reload();
    await screen.getByRole('textbox', '搜索申请单').fill(code);
    await screen.getByRole('combobox', '筛选状态').press('Enter');
    await screen.getByRole('option', '已提交').click();
    await expect(row).toContainText('已提交');
    await expect(screen.getByRole('row', /季度办公耗材/)).not.toBeVisible();
    await row.getByRole('button', '查看详情').click();
    await expect(screen.getByRole('heading', title)).toBeVisible();
    await expect(screen.getByTestId('procurement-code')).toContainText(code);
    await expect(screen.getByText('合计 ¥259.00')).toBeVisible();
    await expect(screen.getByText('直接提交后刷新检查')).toBeVisible();
    await expect(button('下载 quote.txt')).toBeVisible();
    const download = await browser.waitForDownload(() => button('下载 quote.txt').click());
    assert.equal(await readFile(download.absolutePath, 'utf8'), await readFile('test-support/quote.txt', 'utf8'));
});

test('空表单不能进入下一步，草稿删除后刷新仍不存在', async ({ app, screen, browser }) => {
  await login(app, screen);
  await screen.getByRole('link', '采购申请').click();
  await screen.getByRole('button', '创建申请单').click();
  await screen.getByRole('button', '下一步').click();
  await expect(screen.getByRole('heading', '基本信息')).toBeVisible();
  await expect(screen.getByRole('alert')).toContainText('请输入申请标题');
  await screen.getByPlaceholder('例如：研发工作站采购').fill('临时删除草稿');
  await screen.getByRole('button', '保存草稿').click();
  const row = screen.getByRole('row', /临时删除草稿/);
  await expect(row).toContainText('草稿');
  await row.getByRole('button', '删除草稿').click();
  await screen.getByRole('button', '取消').click();
  await expect(row).toBeVisible();
  await row.getByRole('button', '删除草稿').click();
  await screen.getByRole('button', '确认删除草稿').click();
  await expect(row).not.toBeVisible();
  await browser.reload();
  await expect(row).not.toBeVisible();
});
