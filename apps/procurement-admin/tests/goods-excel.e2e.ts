import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import ExcelJS from 'exceljs';
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { createDraft, createSupplier } from '../test-support/fixtures.ts';
import { login } from '../test-support/login.ts';

test('物资 Excel 模板、错误行、取消、勾选追加及导出回读', async ({app, browser, screen}) => {
  const draft = await createDraft(app, await createSupplier(app));
  await login(app, screen);
  await app.open('/#/requests/' + draft.id);
  const button = (name: string) => screen.getByRole('button', name);
  await button('下一步').click();
  const template = await browser.waitForDownload(() => button('下载 Excel 模板').click());
  const book = new ExcelJS.Workbook();
  await book.xlsx.readFile(template.absolutePath);
  const sheet = book.getWorksheet('采购明细')!;
  assert.deepEqual(sheet.getRow(1).values.slice(1), ['品名', '规格', '数量', '单价（CNY）']);
  sheet.addRows([['扩展坞', 'USB-C', 2, 129.50], ['错误的数量', '', 0, 6], ['未选中', '', 1, 7]]);
  const dir = await mkdtemp(join(tmpdir(), 'procurement-excel-'));
  try {
    const path = join(dir, '采购录入.xlsx');
    await book.xlsx.writeFile(path);
    const input = browser.locator('input[type=file]');
    await input.setInputFiles(path);
    await expect(screen.getByText('数量必须为正整数')).toBeVisible();
    await button('取消').click();
    await expect(screen.getByText('合计 ¥200.00')).toBeVisible();
    await input.setInputFiles(path);
    await expect(screen.getByRole('checkbox', '选择第 3 行')).toBeDisabled();
    await screen.getByRole('checkbox', '选择第 4 行').click();
    await button('确认导入').click();
    await expect(screen.getByText('合计 ¥459.00')).toBeVisible();
    await button('保存草稿').click();
    const row = screen.getByRole('row', new RegExp(draft.title));
    await row.getByRole('button','继续编辑').click();
    const exported = await browser.waitForDownload(() => button('导出明细').click());
    const output = new ExcelJS.Workbook();
    await output.xlsx.readFile(exported.absolutePath);
    const goods = output.getWorksheet('采购明细')!;
    assert.equal(goods.actualRowCount, 3);
    assert.deepEqual(goods.getRow(2).values.slice(1), ['会议设备','标准版',1,200]);
    assert.deepEqual(goods.getRow(3).values.slice(1), ['扩展坞','USB-C',2,129.5]);
  } finally { await rm(dir, {recursive:true, force:true}); }
});
