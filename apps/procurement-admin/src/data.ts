import { ProcurementError, type RequestForm, type ApprovalStage } from './domain.ts';
import type { StoredRequest, Attachment, Supplier } from './storage-model.ts';
export { departments, tags, suppliers, newSupplier, total, money } from './storage-model.ts';
export type { Supplier } from './storage-model.ts';
export type { RequestForm } from './domain.ts';
export { newRequest as newForm } from './domain.ts';

/** Use the shared service as the sole source of truth; never fall back to browser storage. */
async function api<T>(path:string,data?:unknown):Promise<T> {
  const response=await fetch('/api/procurement/'+path,data===undefined?{cache:'no-store'}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  const result=await response.json();
  if(!response.ok)throw new ProcurementError(result.error);
  return result as T;
}
/** Serialize original file bytes for the local API without losing File metadata. */
async function serializeRequest(form:RequestForm):Promise<StoredRequest> {
  const files:Attachment[]=await Promise.all(form.files.map(async f=>{
    const bytes=new Uint8Array(await f.arrayBuffer());let binary='';
    for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
    return {name:f.name,type:f.type,lastModified:f.lastModified,base64:btoa(binary)};
  }));return {...form,files};
}
/** Reconstruct real Files for the existing upload/download UI. */
function deserializeRequest(r:StoredRequest):RequestForm {return {...r,files:r.files.map(f=>{const binary=atob(f.base64);return new File([Uint8Array.from(binary,c=>c.charCodeAt(0))],f.name,{type:f.type,lastModified:f.lastModified});})};}
/** List the shared supplier directory. */
export function listSuppliers(){return api<Supplier[]>('suppliers');}
/** Save supplier changes through centralized validation. */
export async function saveSupplier(supplier:Supplier){await api('suppliers/save',{supplier});}
/** Delete a supplier after server-side reference checks. */
export async function deleteSupplier(id:string){await api('suppliers/delete',{id});}
/** Read all shared requests. */
export async function listRequests(){return (await api<StoredRequest[]>('requests')).map(deserializeRequest);}
/** Read one shared request and its attachments. */
export async function getRequest(id:string){return deserializeRequest(await api<StoredRequest>('requests/'+encodeURIComponent(id)));}
/** Save a new or existing form and files on disk. */
export async function saveRequest(form:RequestForm,operation:'create'|'update'){await api('requests/save',{form:await serializeRequest(form),operation});}
/** Persist one approval decision. */
export async function reviewRequest(id:string,revision:number,stage:ApprovalStage,action:'通过'|'驳回',comment:string){await api('requests/review',{id,revision,stage,action,comment});}
/** Delete a confirmed draft revision. */
export async function deleteRequest(id:string,revision:number){await api('requests/delete',{id,revision});}
/** Explicitly reset data for all browsers sharing this project. */
export async function resetRequests(){await api('reset',{});}
