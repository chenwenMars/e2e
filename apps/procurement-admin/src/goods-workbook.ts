import ExcelJS from 'exceljs';
import { ProcurementError, validateGoodsLine, type Currency, type GoodsLine } from './domain.ts';

export interface PreviewRow {
  row: number;
  cells: string[];
  issues: string[];
  line: GoodsLine;
}
const sheetName = '采购明细';
/** Pin price units in the sheet so an export cannot silently change currency on import. */
function headers(currency: Currency) { return ['品名', '规格', '数量', `单价（${currency}）`]; }

/** Build the same editable Excel format for both blank templates and populated exports. */
export async function writeGoodsWorkbook(lines: GoodsLine[], currency: Currency) {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet(sheetName, { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = headers(currency).map((header, i) => ({ header, width: [32, 32, 15, 20][i] }));
  sheet.getColumn(4).numFmt = '#,##0.00';
  sheet.getRow(1).eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF245BC4' } };
  });
  sheet.getRow(1).height = 24;
  sheet.getCell('A1').note = '从第 2 行起填写；品名、数量和单价必填，规格可留空。';
  sheet.getCell('C1').note = '请输入正整数。';
  sheet.getCell('D1').note = '请输入大于零的单价，最多两位小数。';
  for (const line of lines) sheet.addRow([line.name, line.specification, line.quantity, line.price]);
  return book.xlsx.writeBuffer();
}

/** Accept ordinary Excel numbers and plain decimal text, leaving bad input visible for correction. */
function numeric(text: string) { return /^\d+(?:\.\d+)?$/.test(text) ? Number(text) : NaN; }

/** Validate the sheet contract first, then preserve worksheet row numbers and every row-level error. */
export async function readGoodsWorkbook(bytes: ArrayBuffer, currency: Currency): Promise<PreviewRow[]> {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(bytes);
  const sheet = book.getWorksheet(sheetName);
  if (!sheet) throw new ProcurementError('缺少「采购明细」工作表，请使用下载的模板');
  const expected = headers(currency);
  const heading = sheet.getRow(1);
  if (heading.actualCellCount !== expected.length || expected.some((label, i) => heading.getCell(i + 1).value !== label))
    throw new ProcurementError(`模板表头或结算币种不匹配，应为：${expected.join('、')}`);
  const rows: PreviewRow[] = [];
  sheet.eachRow((row, index) => {
    if (index === 1) return;
    const issues: string[] = [];
    const cells = expected.map((label, i) => {
      const cell = row.getCell(i + 1);
      const value = cell.value;
      if (value == null) return '';
      if (typeof value === 'number' || typeof value === 'string') return String(value).trim();
      if (typeof value === 'object' && 'richText' in value) return cell.text.trim();
      issues.push(label + '不能包含公式、日期或其他特殊单元格');
      return cell.formula ? '=' + cell.formula : cell.text;
    });
    row.eachCell((cell, column) => { if (column > expected.length) issues.push(`${cell.address} 超出模板列`); });
    if (!issues.length && cells.every(v => !v)) return;
    const [name, specification, quantity, price] = cells;
    const line = { name, specification, quantity: numeric(quantity), price: numeric(price) };
    issues.push(...validateGoodsLine(line, index - 1).map(i => i.message));
    rows.push({ row: index, cells, line, issues });
  });
  if (!rows.length) throw new ProcurementError('工作表没有可导入的明细，请从第 2 行开始填写');
  return rows;
}
