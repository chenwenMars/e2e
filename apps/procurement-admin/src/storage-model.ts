export const departments = ["研发部", "行政部", "财务部", "运营部"];
export const suppliers = [
  "青禾办公用品",
  "远山信息技术",
  "北辰仪器设备",
  "方圆印务",
];
export const tags = ["项目交付", "日常运营", "设备更新"];
import { costCenters, type Currency, newRequest, totalCents, type RequestForm } from './domain.ts';
/** Format the active procurement type's integer-cent total in settlement units. */
export function total(form: RequestForm) { return totalCents(form) / 100; }

const formatters = new Map<Currency, Intl.NumberFormat>();
/** Display settlement amounts with the same two-place precision as entry and export. */
export function money(amount: number, currency: Currency): string {
  let formatter = formatters.get(currency);
  if (!formatter) {
    formatter = new Intl.NumberFormat('zh-CN', {style: 'currency', currency,
      currencyDisplay: currency === 'CNY' ? 'symbol' : 'code', minimumFractionDigits: 2, maximumFractionDigits: 2});
    formatters.set(currency, formatter);
  }
  return formatter.format(amount);
}

/** Construct the initial demonstration requests without persistence side effects. */
export function requestSeeds(): RequestForm[] {
  return [
    "会议室协作设备",
    "季度办公耗材",
    "实验仪器校准",
    "秋季活动物料",
    "开发工作站扩容",
    "档案装订服务",
  ].map((title, i) => ({
    ...newRequest(),
    id: "PR-100" + (i + 1),
    title,
    costCenter: costCenters[i % costCenters.length],
    department: departments[i % departments.length],
    supplier: suppliers[i % suppliers.length],
    supplierId: `SUP-${i % suppliers.length + 1}`,
    approvalStage: i % 3 === 0 ? "完成" : "部门",
    details: { type: "物资", address: "演示园区一号楼", contact: "admin", installation: false, installationNotes: "" },
    status: i % 3 === 0 ? "草稿" : "已提交",
    date: "2026-11-30",
    updated: "2026-11-0" + (i + 1) + "T09:00:00.000Z",
    purpose: title,
    categories: ["日常运营"],
    lines: [{ name: title, specification: "", quantity: i + 1, price: 200 }],
  }));
}
export interface Supplier {
  id: string; name: string; contact: string; phone: string; email: string; address: string;
  scopes: string[]; enabled: boolean; notes: string;
}

/** Create a supplier editor value. */
export function newSupplier(): Supplier {
  return { id: crypto.randomUUID(), name: "", contact: "", phone: "", email: "", address: "", scopes: ["物资"], enabled: true, notes: "" };
}


/** Restore the original supplier directory without inventing contact information. */
export function supplierSeeds(): Supplier[] {
  return suppliers.map((name, i) => ({ ...newSupplier(), id: `SUP-${i + 1}`, name, scopes: ['物资', '服务', '软件'] }));
}
export interface Attachment { name: string; type: string; lastModified: number; base64: string }
export type StoredRequest = Omit<RequestForm, 'files'> & { files: Attachment[] };
