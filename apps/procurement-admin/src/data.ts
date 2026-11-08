import { openDB, type DBSchema } from "idb";
import type { JSONContent } from "@tiptap/vue-3";

export const departments = ["研发部", "行政部", "财务部", "运营部"];
export const suppliers = [
  "青禾办公用品",
  "远山信息技术",
  "北辰仪器设备",
  "方圆印务",
];
export const tags = ["项目交付", "日常运营", "设备更新"];
export interface RequestForm {
  id: string;
  title: string;
  department: string;
  applicant: string;
  date: string;
  priority: string;
  categories: string[];
  supplier: string;
  purpose: string;
  lines: { name: string; quantity: number; price: number }[];
  notes: JSONContent;
  files: File[];
  step: number;
  status: "草稿" | "已提交";
  updated: string;
}

/** Construct an editable form with its own line items and attachment list. */
export function newForm(): RequestForm {
  return {
    id: crypto.randomUUID(),
    title: "",
    department: "",
    applicant: "admin",
    date: "",
    priority: "普通",
    categories: [],
    supplier: "",
    purpose: "",
    lines: [{ name: "", quantity: 1, price: 0 }],
    notes: { type: "doc", content: [{ type: "paragraph" }] },
    files: [],
    step: 0,
    status: "草稿",
    updated: "",
  };
}

/** Calculate the total in cents before formatting in yuan. */
export function total(form: RequestForm) {
  return (
    form.lines.reduce(
      (sum, line) => sum + Math.round(line.price * 100) * line.quantity,
      0,
    ) / 100
  );
}

export const money = new Intl.NumberFormat("zh-CN", {
  style: "currency",
  currency: "CNY",
});

function seeds(): RequestForm[] {
  return [
    "会议室协作设备",
    "季度办公耗材",
    "实验仪器校准",
    "秋季活动物料",
    "开发工作站扩容",
    "档案装订服务",
  ].map((title, i) => ({
    ...newForm(),
    id: "PR-100" + (i + 1),
    title,
    department: departments[i % departments.length],
    supplier: suppliers[i % suppliers.length],
    status: i % 3 === 0 ? "草稿" : "已提交",
    date: "2026-11-30",
    updated: "2026-11-0" + (i + 1) + "T09:00:00.000Z",
    purpose: title,
    categories: ["日常运营"],
    lines: [{ name: title, quantity: i + 1, price: 200 }],
  }));
}
interface ProcurementDB extends DBSchema {
  requests: { key: string; value: RequestForm };
}
const database = openDB<ProcurementDB>("procurement-admin", 1, {
  upgrade(db) {
    const store = db.createObjectStore("requests", { keyPath: "id" });
    for (const record of seeds()) store.add(record);
  },
});
export async function listRequests() {
  return (await (await database).getAll("requests")).toSorted((a, b) =>
    b.updated.localeCompare(a.updated),
  );
}
export async function getRequest(id: string) {
  const value = await (await database).get("requests", id);
  if (!value) throw new Error("申请单不存在");
  return value;
}
/** Persist the record and all its files as one atomic write. */
export async function saveRequest(form: RequestForm) {
  const tx = (await database).transaction("requests", "readwrite");
  const existing = await tx.store.get(form.id);
  if (existing?.status === "已提交") throw new Error("申请单已提交，无法覆盖");
  await tx.store.put(form);
  await tx.done;
}
export async function resetRequests() {
  const tx = (await database).transaction("requests", "readwrite");
  await tx.store.clear();
  for (const record of seeds()) await tx.store.add(record);
  await tx.done;
}
