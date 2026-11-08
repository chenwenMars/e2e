import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const require = createRequire(import.meta.url);
const webRequire = createRequire(require.resolve('@e2e-dev/web'));
const { chromium } = webRequire('playwright-core');
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '4297', '--strictPort'], { stdio: 'pipe' });
let logs = ''; server.stderr.on('data', b => logs += b);
const origin = 'http://127.0.0.1:4297';
let browser;
try {
  for (let i=0;i<100;i++) { if (server.exitCode !== null) throw new Error(logs); try { const r=await fetch(origin); if(r.ok) break; } catch(error) { logs=error.message; } await delay(100); }
  browser = await chromium.launch();
  for (const version of [1, 2, 3, 4, 5]) {
    const context = await browser.newContext(); const page = await context.newPage();
    // A non-app response gives the fixture an origin without opening the current database.
    await page.route('**/fixture', r => r.fulfill({ body: '<html></html>', contentType: 'text/html' }));
    await page.goto(origin+'/fixture');
    await page.evaluate(async version => {
      await new Promise((resolve,reject) => {
        const request=indexedDB.open('procurement-admin',version);
        request.onupgradeneeded=()=>{
          const db=request.result;
          const store=db.createObjectStore('requests',{keyPath:'id'});
          if(version>=4)store.createIndex('code','code',{unique:true});
          const base={title:'历史附件申请',department:'研发部',applicant:'admin',date:'2027-01-01',priority:'普通',categories:[],supplier:'青禾办公用品',purpose:'迁移测试',lines:[{name:'设备',quantity:2,price:129.5}],notes:{type:'doc',content:[{type:'paragraph'}]},files:[new File(['原始报价内容'],'quote.txt',{type:'text/plain'})],step:3,updated:'2026-10-01T01:00:00.000Z'};
          if(version>=3)Object.assign(base,{details:{type:'物资',address:'已有收货地址',contact:'历史联系人',installation:false,installationNotes:''},supplierId:'SUP-1',revision:7,approvalStage:'财务',history:[{id:'old-event',at:base.updated,action:'通过',stage:'部门',actor:'原审批人',comment:'原审批意见'}]});
          if(version===4)base.code='PR-20261108183045123-550E8400E29B41D4A716446655440000';
          if(version===5){base.code='202611081830450001';const seq=db.createObjectStore('codeSequences');seq.put(2,'20261108183045');}
          store.add({...base,id:'legacy-submitted',status:'已提交',...(version>=2?{supplierId:'SUP-1'}:{})});
          store.add({...base,id:'legacy-draft',status:'草稿',supplier:'',files:[],...(version>=3?{supplierId:'',revision:0}:{}),...(version===4?{code:'PR-20261108183045123-550E8400E29B41D4A716446655440001'}:{}),...(version===5?{code:'202611081830450002'}:{})});
          if(version>=2){const directory=db.createObjectStore('suppliers',{keyPath:'id'});directory.createIndex('name','name',{unique:true});directory.add({id:'SUP-1',name:'青禾办公用品',contact:'',phone:'',email:'',address:'',scopes:['物资'],enabled:true,notes:''});}
        };
        request.onsuccess=()=>{request.result.close();resolve();};request.onerror=()=>reject(request.error);
      });
    }, version);
    const result = await page.evaluate(async () => {
      const data=await import('/src/data.ts');
      const submitted=await data.getRequest('legacy-submitted');const draft=await data.getRequest('legacy-draft');
      return {id:submitted.id,total:data.total(submitted),status:submitted.status,updated:submitted.updated,attachment:await submitted.files[0].text(),supplierId:submitted.supplierId,details:submitted.details,history:submitted.history,stage:submitted.approvalStage,draftSupplier:draft.supplierId};
    });
    const expected={id:'legacy-submitted',total:259,status:'已提交',updated:'2026-10-01T01:00:00.000Z',attachment:'原始报价内容',supplierId:'SUP-1',details:{type:'物资',address:'',contact:'',installation:false,installationNotes:''},history:[],stage:'部门',draftSupplier:''};
    if(version>=3){expected.details.address='已有收货地址';expected.details.contact='历史联系人';expected.stage='财务';expected.history=[{id:'old-event',at:'2026-10-01T01:00:00.000Z',action:'通过',stage:'部门',actor:'原审批人',comment:'原审批意见'}];}
    assert.deepEqual(result,expected);
    const codes=await page.evaluate(async()=>{const d=await import('/src/data.ts');return(await d.listRequests()).map(r=>r.code);});
    codes.forEach(code=>assert.match(code,/^\d{12}$/));assert.equal(new Set(codes).size,2);
    await page.reload();
    assert.deepEqual(await page.evaluate(async()=>{const d=await import('/src/data.ts');return(await d.listRequests()).map(r=>r.code);}),codes);
    assert.equal(await page.evaluate(async () => {const d=await import('/src/data.ts');const f=await d.getRequest('legacy-draft');await d.deleteRequest(f.id,f.revision);try{await d.saveRequest({...f,title:'历史草稿'},'update');return false;}catch(e){return /已删除/.test(e.message);}}),true);
    console.log(`PASS v${version} → v6 migration: IDs, amount, timestamp, status, missing fields, attachment bytes`);
    await context.close();
  }
  const sharedContext = await browser.newContext();
  const page = await sharedContext.newPage(); await page.goto(origin);
  const checks = await page.evaluate(async () => {
    const d=await import('/src/data.ts');
    const s={...d.newSupplier(),name:'规则测试供应商',contact:'张三',phone:'13800138000',email:'test@example.com',address:'上海'};
    await d.saveSupplier(s);
    const errors=[];
    try {await d.saveSupplier({...s,id:crypto.randomUUID(),name:' 规则测试供应商 '});}catch(e){errors.push(e.message);}
    const f=d.newForm();Object.assign(f,{title:'事务测试',department:'研发部',date:'2027-01-01',purpose:'测试',supplierId:s.id,lines:[{name:'设备',specification:'',quantity:1,price:100}],details:{type:'物资',address:'上海',contact:'张三',installation:false,installationNotes:''}});
    await d.saveRequest(f, 'create');let draft=await d.getRequest(f.id);
    const issuedCode=draft.code;await d.saveRequest({...draft,code:'被篡改的编码'},'update');draft=await d.getRequest(f.id);if(draft.code!==issuedCode)throw new Error('编辑覆盖了采购编码');
    try {await d.deleteSupplier(s.id);}catch(e){errors.push(e.message);}
    await d.saveSupplier({...s,enabled:false});
    try {await d.saveRequest({...draft,status:'已提交'}, 'update');}catch(e){errors.push(e.message);}
    await d.saveSupplier({...s,enabled:true,scopes:['软件']});
    try {await d.saveRequest({...draft,status:'已提交'}, 'update');}catch(e){errors.push(e.message);}
    await d.saveSupplier(s);await d.saveRequest({...draft,status:'已提交'}, 'update');
    try {await d.saveRequest({...draft,status:'已提交'}, 'update');}catch(e){errors.push(e.message);}
    let submitted=await d.getRequest(f.id);
    await d.reviewRequest(f.id,submitted.revision,'部门','驳回','补充说明');
    const rejected=await d.getRequest(f.id);await d.saveRequest({...rejected,status:'已提交'},'update');submitted=await d.getRequest(f.id);
    if(submitted.code!==draft.code)throw new Error('驳回重提改变了采购编码');
    if(!draft.code || submitted.code!==draft.code) throw new Error('提交改变了采购编码');
    await d.reviewRequest(f.id,submitted.revision,'部门','通过','同意');
    try {await d.reviewRequest(f.id,submitted.revision,'部门','通过','重复');}catch(e){errors.push(e.message);}
    const deleted=d.newForm();deleted.title='待删除';await d.saveRequest(deleted, 'create');const stale=await d.getRequest(deleted.id);await d.deleteRequest(stale.id,stale.revision);
    let staleRejected=false;try{await d.saveRequest(stale, 'update');}catch(e){staleRejected=/已删除/.test(e.message);}
    const approved=await d.getRequest(f.id);if(approved.code!==draft.code)throw new Error('审批改变了采购编码');
    const direct={...d.newForm(),...f,id:crypto.randomUUID(),code:'伪造编码',status:'已提交'};await d.saveRequest(direct,'create');const directSaved=await d.getRequest(direct.id);
    if(!/^\d{12}$/.test(directSaved.code)||directSaved.code===draft.code)throw new Error('直接提交未独立生成采购编码');
    const parallel=Array.from({length:20},()=>({...d.newForm(),title:'并发草稿'}));await Promise.all(parallel.map(r=>d.saveRequest(r,'create')));
    const allCodes=(await d.listRequests()).map(r=>r.code);if(new Set(allCodes).size!==allCodes.length)throw new Error('并发生成重复编码');
    const raw=await new Promise((resolve,reject)=>{const r=indexedDB.open('procurement-admin');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
    const uniqueIndex=raw.transaction('requests').objectStore('requests').index('code').unique;
    const collision=await new Promise(resolve=>{const tx=raw.transaction('requests','readwrite');tx.objectStore('requests').add({...directSaved,id:crypto.randomUUID()});tx.oncomplete=()=>resolve('accepted');tx.onabort=()=>resolve(tx.error?.name);});raw.close();
    return {uniqueIndex,collision,staleRejected,errors,status:(await d.getRequest(f.id)).status};
  });
  assert.equal(checks.uniqueIndex,true);assert.equal(checks.collision,'ConstraintError');
  assert.equal(checks.staleRejected,true,'a deleted draft must not be recreated by a stale editor');
  assert.equal(checks.status,'已通过');
  assert.equal(checks.errors.length,6);
  assert.match(checks.errors[0],/名称已存在/);assert.match(checks.errors[1],/引用/);assert.match(checks.errors[2],/启用/);assert.match(checks.errors[3],/供应范围/);assert.match(checks.errors[4],/无法覆盖/);assert.match(checks.errors[5],/状态已变更/);
  console.log('PASS real IndexedDB transactions: unique names, references, disabled/scope validation, duplicate submit/approval, single-stage approval');
  await page.clock.setFixedTime(new Date('2027-01-01T00:00:00Z'));
  const peer=await page.context().newPage();await peer.clock.setFixedTime(new Date('2027-01-01T00:00:00Z'));await peer.goto(origin);
  const issue=async current=>current.evaluate(async()=>{const d=await import('/src/data.ts');const f=d.newForm();f.title='每日流水验证';await d.saveRequest(f,'create');const saved=await d.getRequest(f.id);return {id:saved.id,code:saved.code,revision:saved.revision};});
  const issued=await Promise.all([issue(page),issue(peer)]);
  assert.deepEqual(issued.map(r=>r.code).sort(),['202701010001','202701010002']);
  await page.evaluate(async r=>{const d=await import('/src/data.ts');await d.deleteRequest(r.id,r.revision);},issued[0]);
  await page.reload();assert.equal((await issue(page)).code,'202701010003');
  await page.clock.setFixedTime(new Date('2027-01-01T15:59:59Z'));assert.equal((await issue(page)).code,'202701010004');
  await page.clock.setFixedTime(new Date('2027-01-01T16:00:00Z'));assert.equal((await issue(page)).code,'202701020001');
  console.log('PASS two-tab daily sequences, persistence after deletion/reload, same-day continuation and Beijing midnight restart');
} finally { await browser?.close(); server.kill(); }
