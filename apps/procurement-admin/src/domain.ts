import type { JSONContent } from '@tiptap/vue-3';

export type ProcurementType = '物资' | '服务' | '软件';
export type RequestStatus = '草稿' | '已提交' | '已通过' | '已驳回';
export type ApprovalStage = '部门' | '财务' | '完成';
export type ProcurementDetails =
  | { type: '物资'; address: string; contact: string; installation: boolean; installationNotes: string }
  | { type: '服务'; category: string; start: string; end: string; location: string; deliverables: string; milestones: { name: string; date: string; amount: number }[] }
  | { type: '软件'; product: string; seats: number; unitPrice: number; months: number; start: string; autoRenew: boolean; sensitivity: string };
export interface ApprovalEvent { id: string; at: string; action: '提交' | '通过' | '驳回'; stage: ApprovalStage; actor: string; comment: string }
export interface RequestForm {
  id: string; code: string; title: string; department: string; applicant: string; date: string; priority: string; categories: string[];
  supplier: string; supplierId: string; purpose: string;
  lines: { name: string; specification: string; quantity: number; price: number }[];
  details: ProcurementDetails; notes: JSONContent; files: File[]; step: number; status: RequestStatus; updated: string;
  approvalStage: ApprovalStage; history: ApprovalEvent[]; revision: number;
}
export interface ValidationIssue { field: string; step: number; message: string }
export class ProcurementError extends Error {
  constructor(message: string) { super(message); this.name = 'ProcurementError'; }
}
/** Create the fields owned by one procurement type. */
export function newDetails(type: ProcurementType): ProcurementDetails {
  switch (type) {
    case '物资': return { type, address: '', contact: '', installation: false, installationNotes: '' };
    case '服务': return { type, category: '', start: '', end: '', location: '', deliverables: '', milestones: [{ name: '', date: '', amount: 0 }] };
    case '软件': return { type, product: '', seats: 1, unitPrice: 0, months: 12, start: '', autoRenew: false, sensitivity: '内部' };
  }
}
/** Format a Beijing-time date and its transaction-allocated four-digit sequence. */
export function createProcurementCode(at: Date, sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > 9999) throw new ProcurementError('当日采购流水号已满或无效（范围 0001–9999）');
  const timestamp = new Date(at.getTime() + 8 * 60 * 60 * 1000).toISOString().replace(/\D/g, '').slice(0, 8);
  return `${timestamp}${String(sequence).padStart(4, '0')}`;
}
/** Create an independently editable procurement request. */
export function newRequest(): RequestForm {
  return { id: crypto.randomUUID(), code: '', title: '', department: '', applicant: 'admin', date: '', priority: '普通', categories: [], supplier: '', supplierId: '', purpose: '', lines: [{ name: '', specification: '', quantity: 1, price: 0 }], details: newDetails('物资'), notes: { type: 'doc', content: [{ type: 'paragraph' }] }, files: [], step: 0, status: '草稿', updated: '', approvalStage: '完成', history: [], revision: 0 };
}
/** Calculate the active type's amount using integer cents. */
export function totalCents(form: RequestForm): number {
  const d = form.details;
  if (d.type === '软件') return Math.round(d.unitPrice * 100) * d.seats * d.months;
  if (d.type === '服务') return d.milestones.reduce((sum, m) => sum + Math.round(m.amount * 100), 0);
  return form.lines.reduce((sum, l) => sum + Math.round(l.price * 100) * l.quantity, 0);
}
/** Check a calendar date rather than accepting normalized impossible dates. */
function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}
/** Money inputs allow positive finite values with at most two decimal places. */
function validMoney(value: number): boolean {
  return Number.isFinite(value) && value > 0 && Number.isSafeInteger(Math.round(value * 100)) && Math.abs(value * 100 - Math.round(value * 100)) < 0.000001;
}
/** Validate submission fields centrally, with locations for inline UI errors. */
export function validateRequest(f: RequestForm): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const require = (ok: boolean, field: string, step: number, message: string) => { if (!ok) issues.push({ field, step, message }); };
  require(!!f.title.trim(), 'title', 0, '请输入申请标题');
  require(!!f.department, 'department', 0, '请选择申请部门');
  require(!!f.applicant.trim(), 'applicant', 0, '请输入申请人');
  require(validDate(f.date), 'date', 0, '请输入有效的期望到货日期');
  require(!!f.purpose.trim(), 'purpose', 0, '请输入采购事由');
  require(!!f.supplierId, 'supplierId', 1, '请选择供应商');
  const d = f.details;
  if (d.type === '物资') {
    require(f.lines.length > 0, 'lines', 1, '请至少添加一条采购明细');
    f.lines.forEach((l, i) => {
      require(!!l.name.trim(), `lines.${i}.name`, 1, `请输入品名 ${i + 1}`);
      require(Number.isSafeInteger(l.quantity) && l.quantity > 0, `lines.${i}.quantity`, 1, '数量必须为正整数');
      require(validMoney(l.price), `lines.${i}.price`, 1, '单价必须大于零且最多两位小数');
    });
    require(!!d.address.trim(), 'address', 1, '请输入收货地址');
    require(!!d.contact.trim(), 'contact', 1, '请输入收货联系人');
    require(!d.installation || !!d.installationNotes.trim(), 'installationNotes', 1, '请填写安装说明');
  } else if (d.type === '服务') {
    require(!!d.category, 'category', 1, '请选择服务类别');
    require(validDate(d.start) && validDate(d.end) && d.start <= d.end, 'period', 1, '请输入有效的服务起止日期');
    require(!!d.location.trim(), 'location', 1, '请输入服务地点');
    require(!!d.deliverables.trim(), 'deliverables', 1, '请输入交付说明');
    require(d.milestones.length > 0, 'milestones', 1, '至少添加一个里程碑');
    d.milestones.forEach((m, i) => {
      require(!!m.name.trim(), `milestones.${i}.name`, 1, '请输入里程碑名称');
      require(validDate(m.date) && m.date >= d.start && m.date <= d.end, `milestones.${i}.date`, 1, '里程碑日期必须在服务期间内');
      require(validMoney(m.amount), `milestones.${i}.amount`, 1, '里程碑金额必须大于零且最多两位小数');
    });
  } else {
    require(!!d.product.trim(), 'product', 1, '请输入软件产品名称');
    require(Number.isSafeInteger(d.seats) && d.seats > 0, 'seats', 1, '授权席位必须为正整数');
    require(Number.isSafeInteger(d.months) && d.months > 0, 'months', 1, '订阅月数必须为正整数');
    require(validMoney(d.unitPrice), 'unitPrice', 1, '每席月单价必须大于零且最多两位小数');
    require(validDate(d.start), 'start', 1, '请输入有效的订阅起始日期');
    require(['公开', '内部', '敏感'].includes(d.sensitivity), 'sensitivity', 1, '请选择数据敏感级别');
  }
  require(Number.isSafeInteger(totalCents(f)) && totalCents(f) > 0, 'total', 1, '采购总额无效或超过可精确计算范围');
  return issues;
}
/** Determine the approval route from the submitted amount. */
export function approvalPath(form: RequestForm): ('部门' | '财务')[] {
  return totalCents(form) >= 1_000_000 ? ['部门', '财务'] : ['部门'];
}
/** Advance only the currently pending stage; reject stale actions. */
export function nextApproval(form: RequestForm, stage: ApprovalStage, action: '通过' | '驳回', comment: string): Pick<RequestForm, 'status' | 'approvalStage'> {
  if (form.status !== '已提交' || form.approvalStage !== stage || stage === '完成') throw new ProcurementError('审批状态已变更，请刷新后重试');
  if (!comment.trim()) throw new ProcurementError('请填写审批意见');
  if (action === '驳回') return { status: '已驳回', approvalStage: '完成' };
  if (stage === '部门' && approvalPath(form).includes('财务')) return { status: '已提交', approvalStage: '财务' };
  return { status: '已通过', approvalStage: '完成' };
}
