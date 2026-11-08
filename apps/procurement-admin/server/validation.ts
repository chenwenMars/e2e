import { ProcurementError } from '../src/domain.ts';
import type { Supplier, StoredRequest } from '../src/storage-model.ts';

/** Require an object at the HTTP boundary, before business code trusts it. */
export function object(value:unknown): Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new ProcurementError('请求内容必须为对象');
  return value as Record<string,unknown>;
}
/** Read a required string without implicitly coercing client data. */
export function text(value:unknown,label:string):string {if(typeof value!=='string')throw new ProcurementError(`${label}必须为字符串`);return value;}
/** Read a safe nonnegative revision or sequence. */
export function integer(value:unknown,label:string):number {if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)throw new ProcurementError(`${label}必须为非负整数`);return value;}
/** Check a fixed set of wire values. */
export function choice<const T extends string>(value:unknown,values:readonly T[],label:string):T {if(!values.includes(value as T))throw new ProcurementError(`${label}无效`);return value as T;}
/** Check an explicitly supplied array. */
function array(value:unknown,label:string):unknown[] {if(!Array.isArray(value))throw new ProcurementError(`${label}必须为数组`);return value;}
/** Reject non-finite numeric fields before they reach arithmetic. */
function number(value:unknown,label:string) {if(typeof value!=='number'||!Number.isFinite(value))throw new ProcurementError(`${label}必须为有限数字`);}
/** Validate the supplier wire shape before business validation. */
export function supplier(value:unknown):Supplier {
  const s=object(value);for(const key of ['id','name','contact','phone','email','address','notes'])text(s[key],key);
  if(!s.id)throw new ProcurementError('供应商 ID 不能为空');
  if(typeof s.enabled!=='boolean')throw new ProcurementError('供应商启用状态无效');
  array(s.scopes,'供应范围').forEach(v=>choice(v,['物资','服务','软件'],'供应范围'));
  return s as unknown as Supplier;
}
/** Validate stored form structure separately from submission completeness. */
export function request(value:unknown):StoredRequest {
  const r=object(value);
  for(const key of ['id','code','title','department','applicant','date','priority','supplier','supplierId','purpose','updated'])text(r[key],key);
  if(!r.id)throw new ProcurementError('申请 ID 不能为空');
  integer(r.revision,'版本');const step=integer(r.step,'步骤');if(step>3)throw new ProcurementError('步骤无效');
  choice(r.status,['草稿','已提交','已通过','已驳回'],'申请状态');choice(r.approvalStage,['部门','财务','完成'],'审批节点');
  array(r.categories,'用途标签').forEach(v=>text(v,'标签'));
  array(r.lines,'采购明细').forEach(value=>{const l=object(value);text(l.name,'品名');text(l.specification,'规格');number(l.quantity,'数量');number(l.price,'单价');});
  const d=object(r.details);choice(d.type,['物资','服务','软件'],'采购类型');
  if(d.type==='物资'){for(const k of ['address','contact','installationNotes'])text(d[k],k);if(typeof d.installation!=='boolean')throw new ProcurementError('安装状态无效');}
  if(d.type==='服务') {for(const k of ['category','start','end','location','deliverables'])text(d[k],k);array(d.milestones,'里程碑').forEach(v=>{const m=object(v);text(m.name,'里程碑名称');text(m.date,'里程碑日期');number(m.amount,'里程碑金额');});}
  if(d.type==='软件'){for(const k of ['product','start','sensitivity'])text(d[k],k);for(const k of ['seats','unitPrice','months'])number(d[k],k);if(typeof d.autoRenew!=='boolean')throw new ProcurementError('续费状态无效');}
  object(r.notes);
  array(r.history,'审批历史').forEach(v=>{const e=object(v);for(const k of ['id','at','actor','comment'])text(e[k],k);choice(e.action,['提交','通过','驳回'],'历史动作');choice(e.stage,['部门','财务','完成'],'历史节点');});
  array(r.files,'附件').forEach(v=>{const f=object(v);text(f.name,'附件名');text(f.type,'附件类型');integer(f.lastModified,'附件时间');const b=text(f.base64,'附件字节');if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b))throw new ProcurementError('附件 base64 编码无效');});
  return r as unknown as StoredRequest;
}
