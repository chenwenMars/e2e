import { openDB, unwrap, type DBSchema } from "idb";

export const departments = ["研发部", "行政部", "财务部", "运营部"];
export const suppliers = [
  "青禾办公用品",
  "远山信息技术",
  "北辰仪器设备",
  "方圆印务",
];
export const tags = ["项目交付", "日常运营", "设备更新"];
export { newRequest as newForm } from './domain.ts';
export type { RequestForm } from './domain.ts';
import { newRequest, createProcurementCode, newDetails, totalCents, validateRequest, nextApproval, ProcurementError, type RequestForm, type ApprovalStage } from './domain.ts';
/** Format the active procurement type's integer-cent total as yuan. */
export function total(form: RequestForm) { return totalCents(form) / 100; }

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
    ...newRequest(),
    id: "PR-100" + (i + 1),
    title,
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

interface ProcurementDB extends DBSchema {
  codeSequences: { key: string; value: number };
  suppliers: { key: string; value: Supplier; indexes: { name: string } };
  requests: { key: string; value: RequestForm; indexes: { code: string } };
}
/** Restore the original supplier directory without inventing contact information. */
function supplierSeeds(): Supplier[] {
  return suppliers.map((name, i) => ({ ...newSupplier(), id: `SUP-${i + 1}`, name, scopes: ['物资', '服务', '软件'] }));
}
const database = openDB<ProcurementDB>("procurement-admin", 6, {
  upgrade(db, oldVersion, _newVersion, transaction) {
    const sequences = oldVersion < 5 ? db.createObjectStore('codeSequences') : transaction.objectStore('codeSequences');
    if (oldVersion >= 5) sequences.clear();
    const issuedAt = new Date();
    let assigned = 0;
    const issueMigrationCode = () => {
      const date = new Date(issuedAt.getTime() + Math.floor(assigned / 9999) * 86_400_000);
      const sequence = assigned % 9999 + 1;
      assigned++;
      const code = createProcurementCode(date, sequence);
      sequences.put(sequence, code.slice(0, 8));
      return code;
    };
    if (oldVersion === 0) {
      const requests = db.createObjectStore('requests', { keyPath: 'id' });
      requests.createIndex('code', 'code', { unique: true });
      const directory = db.createObjectStore('suppliers', { keyPath: 'id' });
      directory.createIndex('name', 'name', { unique: true });
      for (const supplier of supplierSeeds()) directory.add(supplier);
      for (const request of seeds()) requests.add({ ...request, code: issueMigrationCode() });
      return;
    }
    if (oldVersion < 2) {
      const directory = db.createObjectStore('suppliers', { keyPath: 'id' });
      directory.createIndex('name', 'name', { unique: true });
      for (const supplier of supplierSeeds()) directory.add(supplier);
    }
    if (oldVersion < 4) transaction.objectStore('requests').createIndex('code', 'code', { unique: true });
    // Native cursor callbacks keep migration requests inside the versionchange transaction.
    const native = unwrap(transaction);
    const directory = native.objectStore('suppliers').getAll();
    directory.onsuccess = () => {
      const names = new Map((directory.result as Supplier[]).map(s => [s.name, s.id]));
      const cursor = native.objectStore('requests').openCursor();
      cursor.onsuccess = () => {
        const current = cursor.result;
        if (!current) return;
        const old = current.value as RequestForm;
        if (oldVersion >= 3) {
          current.update({ ...old, code: issueMigrationCode() });
          current.continue();
          return;
        }
        current.update({ ...old, code: issueMigrationCode(), supplierId: old.supplierId ?? names.get(old.supplier) ?? '', details: newDetails('物资'), lines: old.lines.map(l => ({ ...l, specification: '' })), approvalStage: old.status === '已提交' ? '部门' : '完成', history: [], revision: 0 });
        current.continue();
      };
    };
  },
  blocked() { console.error('本地数据库升级被其他页面阻塞，请关闭其他采购工作台标签页后重试'); },
  blocking() { void database.then(db => db.close()); },
});
/** Read the locally managed supplier directory. */
export async function listSuppliers() {
  return (await (await database).getAll("suppliers")).toSorted((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}
/** Validate and save a supplier while preserving request name references. */
export async function saveSupplier(input: Supplier) {
  const value = { ...input, name: input.name.trim() };
  if (!value.name || !value.contact.trim() || !value.address.trim() || !value.scopes.length)
    throw new Error("请填写名称、联系人、地址及供应范围");
  if (!/^[+\d][\d ()-]{5,19}$/.test(value.phone)) throw new Error("请输入有效联系电话");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email)) throw new Error("请输入有效邮箱");
  const tx = (await database).transaction(["suppliers", "requests"], "readwrite");
  const store = tx.objectStore("suppliers");
  const records = await store.getAll();
  if (records.some(s => s.id !== value.id && s.name === value.name)) throw new Error("供应商名称已存在");
  const previous = await store.get(value.id);
  if (previous && previous.name !== value.name) {
    for (const request of await tx.objectStore("requests").getAll()) {
      if (request.supplierId === value.id && ["草稿", "已驳回"].includes(request.status))
        await tx.objectStore("requests").put({ ...request, supplier: value.name });
    }
  }
  await store.put(value);
  await tx.done;
}
/** Reject deletion while a request references the supplier. */
export async function deleteSupplier(id: string) {
  const tx = (await database).transaction(["suppliers", "requests"], "readwrite");
  const supplier = await tx.objectStore("suppliers").get(id);
  if (!supplier) throw new Error("供应商不存在");
  const requests = await tx.objectStore("requests").getAll();
  if (requests.some(r => r.supplierId === id)) throw new Error("供应商已被采购申请引用，请改为停用");
  await tx.objectStore("suppliers").delete(id);
  await tx.done;
}
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
/** Persist a draft or submit a fully validated request with its audit event. */
export async function saveRequest(form: RequestForm, operation: 'create' | 'update') {
  if (!form.title.trim()) throw new ProcurementError('请输入申请标题');
  if (form.status !== '草稿' && form.status !== '已提交') throw new ProcurementError('保存状态无效');
  if (form.status === '已提交') {
    const issues = validateRequest(form);
    if (issues.length) throw new ProcurementError(issues.map(i => i.message).join('；'));
  }
  const tx = (await database).transaction(['requests', 'suppliers', 'codeSequences'], 'readwrite');
  const store = tx.objectStore('requests');
  const existing = await store.get(form.id);
  if (operation === 'update' && !existing) throw new ProcurementError('申请单已删除，请返回列表');
  if (operation === 'create' && existing) throw new ProcurementError('申请单已存在，请刷新后重试');
  if (existing && !['草稿', '已驳回'].includes(existing.status)) throw new ProcurementError('申请单已提交，无法覆盖');
  if (existing && existing.revision !== form.revision) throw new ProcurementError('申请单已变更，请刷新后重试');
  const supplier = form.supplierId ? await tx.objectStore('suppliers').get(form.supplierId) : undefined;
  if (form.supplierId && !supplier) throw new ProcurementError('供应商不存在，请重新选择');
  if (form.status === '已提交' && (!supplier || !supplier.enabled || !supplier.scopes.includes(form.details.type))) throw new ProcurementError('请选择启用且供应范围匹配的供应商');
  const now = new Date().toISOString();
  const history = existing ? existing.history : [];
  let code: string;
  if (existing) code = existing.code;
  else {
    const sequences = tx.objectStore('codeSequences');
    const prefix = createProcurementCode(new Date(now), 1).slice(0, 8);
    const sequence = (await sequences.get(prefix) ?? 0) + 1;
    code = createProcurementCode(new Date(now), sequence);
    await sequences.put(sequence, prefix);
  }
  const record: RequestForm = { ...form, code, supplier: supplier ? supplier.name : '', updated: now, revision: (existing ? existing.revision : 0) + 1, approvalStage: form.status === '已提交' ? '部门' : '完成', history: form.status === '已提交' ? [...history, { id: crypto.randomUUID(), at: now, action: '提交', stage: '部门', actor: form.applicant, comment: '提交采购申请' }] : history };
  await Promise.all([store.put(record), tx.done]);
}
/** Apply one approval decision to the current persisted revision atomically. */
export async function reviewRequest(id: string, revision: number, stage: ApprovalStage, action: '通过' | '驳回', comment: string) {
  const tx = (await database).transaction('requests', 'readwrite');
  const record = await tx.store.get(id);
  if (!record) throw new ProcurementError('申请单不存在');
  if (record.revision !== revision) throw new ProcurementError('审批状态已变更，请刷新后重试');
  const next = nextApproval(record, stage, action, comment);
  const now = new Date().toISOString();
  await tx.store.put({ ...record, ...next, updated: now, revision: record.revision + 1, history: [...record.history, { id: crypto.randomUUID(), at: now, action, stage, actor: `${stage}审批员（本地演示）`, comment: comment.trim() }] });
  await tx.done;
}
/** Delete only a draft at the revision the user confirmed. */
export async function deleteRequest(id: string, revision: number) {
  const tx = (await database).transaction('requests', 'readwrite');
  const record = await tx.store.get(id);
  if (!record || record.status !== '草稿' || record.revision !== revision) throw new ProcurementError('仅可删除当前版本的草稿，请刷新后重试');
  await tx.store.delete(id);
  await tx.done;
}
/** Reset all linked demonstration records in one transaction. */
export async function resetRequests() {
  const tx = (await database).transaction(['requests', 'suppliers', 'codeSequences'], 'readwrite');
  const at = new Date();
  const prefix = createProcurementCode(at, 1).slice(0, 8);
  const sequences = tx.objectStore('codeSequences');
  let sequence = await sequences.get(prefix) ?? 0;
  const records = seeds().map(record => ({ ...record, code: createProcurementCode(at, ++sequence) }));
  await tx.objectStore('requests').clear();
  await tx.objectStore('suppliers').clear();
  for (const supplier of supplierSeeds()) await tx.objectStore('suppliers').add(supplier);
  for (const record of records) await tx.objectStore('requests').add(record);
  await sequences.put(sequence, prefix);
  await tx.done;
}
