import type { App } from 'e2e';
import { newRequest } from '../src/domain.ts';
import { newSupplier } from '../src/storage-model.ts';

/** Give every retained E2E record a new identity without modifying user records. */
export function uniqueTitle(label:string) {return `${label}-${crypto.randomUUID().slice(0,8)}`;}
/** Create one explicit test supplier through the same validated local API. */
export async function createSupplier(app:App) {
  const supplier={...newSupplier(),name:uniqueTitle('E2E供应商'),contact:'测试联系人',phone:'13800138000',email:'e2e@example.com',address:'上海测试园区',scopes:['物资','服务','软件']};
  const response=await fetch(`${app.baseUrl}/api/procurement/suppliers/save`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({supplier})});
  if(!response.ok)throw new Error(await response.text());return supplier;
}
/** Provision an owned draft for reference checks or AI tests, never a user's seed record. */
export async function createDraft(app:App,supplier:Awaited<ReturnType<typeof createSupplier>>,label='E2E采购草稿') {
  const form={...newRequest(),title:uniqueTitle(label),department:'研发部',applicant:'admin',date:'2027-02-01',purpose:'测试业务流程',supplierId:supplier.id,lines:[{name:'会议设备',specification:'标准版',quantity:1,price:200}],details:{type:'物资' as const,address:'上海测试园区',contact:'测试联系人',installation:false,installationNotes:''}};
  const response=await fetch(`${app.baseUrl}/api/procurement/requests/save`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({form,operation:'create'})});
  if(!response.ok)throw new Error(await response.text());return form;
}
