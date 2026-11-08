import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createProcurementCode, validateRequest, nextApproval, ProcurementError, type ApprovalStage } from '../src/domain.ts';
import { requestSeeds, supplierSeeds, type Supplier, type StoredRequest, type Attachment } from '../src/storage-model.ts';

/** Transactional project-local storage, shared by every Vite process. */
export class ProcurementStore {
  private db: DatabaseSync;
  constructor(file: string, options: {seed?: boolean} = {}) {
    mkdirSync(dirname(file), {recursive:true}); this.db = new DatabaseSync(file);
    try {
      this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS suppliers(id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS attachments(request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE, position INTEGER NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, modified INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(request_id,position));
        CREATE TABLE IF NOT EXISTS sequences(day TEXT PRIMARY KEY, value INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
      this.write(()=>{if (!this.db.prepare("SELECT value FROM metadata WHERE key='initialized'").get()) {
        if (options.seed !== false) this.seed(); this.db.prepare("INSERT INTO metadata VALUES('initialized','1')").run();
      }});
    } catch(error) {this.db.close();throw error;}
  }
  /** Release this server connection. */
  close() {if(this.db.isOpen)this.db.close();}
  /** Own a SQLite write lock for the complete read-modify-write operation. */
  private write<T>(fn:()=>T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {const result=fn();this.db.exec('COMMIT');return result;}
    catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  /** Read the daily high-water mark, including codes of deleted records. */
  sequence(day: string): number {const r=this.db.prepare('SELECT value FROM sequences WHERE day=?').get(day);return r ? Number(r.value) : 0;}
  /** Advance a high-water mark without allowing imports to rewind it. */
  private advance(day: string,value: number) {this.db.prepare('INSERT INTO sequences VALUES(?,?) ON CONFLICT(day) DO UPDATE SET value=MAX(value,excluded.value)').run(day,value);}
  /** Allocate a code inside the caller's write transaction. */
  private nextCode() {const now=new Date();const day=createProcurementCode(now,1).slice(0,8);const n=this.sequence(day)+1;const code=createProcurementCode(now,n);this.advance(day,n);return code;}
  /** Read the shared directory. */
  listSuppliers(): Supplier[] {return this.db.prepare('SELECT data FROM suppliers ORDER BY name').all().map(r=>JSON.parse(String(r.data)) as Supplier);}
  /** Persist a directory document and its indexed name. */
  private putSupplier(s: Supplier) {this.db.prepare('INSERT INTO suppliers VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,data=excluded.data').run(s.id,s.name,JSON.stringify(s));}
  /** Read original file bytes in browser wire format. */
  private files(id: string): Attachment[] {return this.db.prepare('SELECT * FROM attachments WHERE request_id=? ORDER BY position').all(id).map(r=>({name:String(r.name),type:String(r.type),lastModified:Number(r.modified),base64:Buffer.from(r.bytes as Uint8Array).toString('base64')}));}
  /** Read an application and its files. */
  getRequest(id: string): StoredRequest {
    if(this.db.isTransaction)return this.readRequest(id);
    this.db.exec('BEGIN');
    try{const record=this.readRequest(id);this.db.exec('COMMIT');return record;}
    catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  /** Read metadata and attachments within an existing snapshot. */
  private readRequest(id: string): StoredRequest {
    const row=this.db.prepare('SELECT data FROM requests WHERE id=?').get(id);if(!row)throw new ProcurementError('申请单不存在');
    return {...JSON.parse(String(row.data)),files:this.files(id)} as StoredRequest;
  }
  /** Read all requests in one consistent snapshot. */
  listRequests(): StoredRequest[] {
    this.db.exec('BEGIN');
    try {const records=this.requests().sort((a,b)=>b.updated.localeCompare(a.updated));this.db.exec('COMMIT');return records;}
    catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  /** Read request documents within an existing transaction. */
  private requests(): StoredRequest[] {return this.db.prepare('SELECT id FROM requests').all().map(r=>this.getRequest(String(r.id)));}
  /** Write metadata and binary attachments together. */
  private putRequest(r: StoredRequest) {
    const {files,...data}=r;
    this.db.prepare('INSERT INTO requests VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET code=excluded.code,data=excluded.data').run(r.id,r.code,JSON.stringify(data));
    this.db.prepare('DELETE FROM attachments WHERE request_id=?').run(r.id);
    const insert=this.db.prepare('INSERT INTO attachments VALUES(?,?,?,?,?,?)');
    files.forEach((f,i)=>insert.run(r.id,i,f.name,f.type,f.lastModified,Buffer.from(f.base64,'base64')));
  }
  /** Validate and save a supplier, preserving draft references by ID. */
  saveSupplier(input: Supplier) {
    const s={...input,name:input.name.trim()};
    if(!s.name||!s.contact.trim()||!s.address.trim()||!s.scopes.length)throw new ProcurementError('请填写名称、联系人、地址及供应范围');
    if(!/^[+\d][\d ()-]{5,19}$/.test(s.phone))throw new ProcurementError('请输入有效联系电话');
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.email))throw new ProcurementError('请输入有效邮箱');
    this.write(()=>{
      if(this.listSuppliers().some(r=>r.id!==s.id&&r.name===s.name))throw new ProcurementError('供应商名称已存在');
      this.putSupplier(s);
      for(const r of this.requests()) if(r.supplierId===s.id&&['草稿','已驳回'].includes(r.status)) this.putRequest({...r,supplier:s.name});
    });
  }
  /** Reject deletion whenever an application references the supplier. */
  deleteSupplier(id: string) {this.write(()=>{
    if(!this.db.prepare('SELECT id FROM suppliers WHERE id=?').get(id))throw new ProcurementError('供应商不存在');
    if(this.requests().some(r=>r.supplierId===id))throw new ProcurementError('供应商已被采购申请引用，请改为停用');
    this.db.prepare('DELETE FROM suppliers WHERE id=?').run(id);
  });}
  /** Validate and save on the server, allocating a code only on creation. */
  saveRequest(form: StoredRequest,operation: 'create'|'update') {this.write(()=>{
    if(!form.title.trim())throw new ProcurementError('请输入申请标题');
    if(!['草稿','已提交'].includes(form.status))throw new ProcurementError('保存状态无效');
    if(form.status==='已提交'){const issues=validateRequest({...form,files:[]});if(issues.length)throw new ProcurementError(issues.map(i=>i.message).join('；'));}
    const row=this.db.prepare('SELECT id FROM requests WHERE id=?').get(form.id);
    if(operation==='update'&&!row)throw new ProcurementError('申请单已删除，请返回列表');
    if(operation==='create'&&row)throw new ProcurementError('申请单已存在，请刷新后重试');
    const existing=row?this.getRequest(form.id):undefined;
    if(existing&&!['草稿','已驳回'].includes(existing.status))throw new ProcurementError('申请单已提交，无法覆盖');
    if(existing&&existing.revision!==form.revision)throw new ProcurementError('申请单已变更，请刷新后重试');
    const supplier=this.listSuppliers().find(s=>s.id===form.supplierId);
    if(form.supplierId&&!supplier)throw new ProcurementError('供应商不存在，请重新选择');
    if(form.status==='已提交'&&(!supplier||!supplier.enabled||!supplier.scopes.includes(form.details.type)))throw new ProcurementError('请选择启用且供应范围匹配的供应商');
    const now=new Date().toISOString();const history=existing?existing.history:[];
    this.putRequest({...form,code:existing?existing.code:this.nextCode(),supplier:supplier?supplier.name:'',updated:now,revision:(existing?existing.revision:0)+1,approvalStage:form.status==='已提交'?'部门':'完成',history:form.status==='已提交'?[...history,{id:crypto.randomUUID(),at:now,action:'提交',stage:'部门',actor:form.applicant,comment:'提交采购申请'}]:history});
  });}
  /** Apply a decision to the current persisted revision only. */
  reviewRequest(id:string,revision:number,stage:ApprovalStage,action:'通过'|'驳回',comment:string) {this.write(()=>{
    const r=this.getRequest(id);if(r.revision!==revision)throw new ProcurementError('审批状态已变更，请刷新后重试');
    const next=nextApproval({...r,files:[]},stage,action,comment);const now=new Date().toISOString();
    this.putRequest({...r,...next,revision:r.revision+1,updated:now,history:[...r.history,{id:crypto.randomUUID(),at:now,action,stage,actor:`${stage}审批员（本地演示）`,comment:comment.trim()}]});
  });}
  /** Delete only the confirmed draft revision. */
  deleteRequest(id:string,revision:number) {this.write(()=>{
    const row=this.db.prepare('SELECT id FROM requests WHERE id=?').get(id);if(!row)throw new ProcurementError('仅可删除当前版本的草稿，请刷新后重试');
    const r=this.getRequest(id);if(r.status!=='草稿'||r.revision!==revision)throw new ProcurementError('仅可删除当前版本的草稿，请刷新后重试');
    this.db.prepare('DELETE FROM requests WHERE id=?').run(id);
  });}
  /** Populate demonstrations without clearing daily sequences. */
  private seed() {for(const s of supplierSeeds())this.putSupplier(s);for(const r of requestSeeds())this.putRequest({...r,files:[],code:this.nextCode()});}
  /** Reset shared data only on an explicit action. */
  reset() {this.write(()=>{this.db.exec('DELETE FROM requests; DELETE FROM suppliers;');this.seed();});}
}
