import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { readGoodsWorkbook, writeGoodsWorkbook } from '../src/goods-workbook.ts';

test('真实工作簿往返保留物资、单价及币种，空模板不能形成明细', async () => {
  const lines = [{name: '0012', specification: '02', quantity: 2, price: 12.34}];
  const bytes = await writeGoodsWorkbook(lines, 'EUR');
  const [row] = await readGoodsWorkbook(bytes, 'EUR');
  assert.deepEqual(row.line, lines[0]);
  assert.deepEqual(row.issues, []);
  await assert.rejects(readGoodsWorkbook(bytes, 'CNY'), /结算币种/);
  await assert.rejects(readGoodsWorkbook(await writeGoodsWorkbook([], 'USD'), 'USD'), /没有可导入/);
});

test('保留原始行号，跳过空行，拒绝公式、额外列、非法数量和单价', async () => {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(await writeGoodsWorkbook([], 'CNY'));
  const sheet = book.getWorksheet('采购明细')!;
  sheet.getRow(3).values = ['合法行', '', '2', '13.50'];
  sheet.getRow(4).values = ['  ', '', -1, 0.001];
  sheet.getRow(5).values = ['带公式', '', {formula: '1+1', result: 2}, 1, '额外数据'];
  const rows = await readGoodsWorkbook(await book.xlsx.writeBuffer(), 'CNY');
  assert.deepEqual(rows.map(r => r.row), [3,4,5]);
  assert.deepEqual(rows[0].issues, []);
  assert.match(rows[1].issues.join(' '), /品名.*数量.*单价/);
  assert.match(rows[2].issues.join(' '), /公式.*超出模板列/);
});
