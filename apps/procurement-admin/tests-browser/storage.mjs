import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { newRequest } from '../src/domain.ts';
const require=createRequire(import.meta.url);const {chromium}=createRequire(require.resolve('@e2e-dev/web'))('playwright-core');
const directory=await mkdtemp(join(tmpdir(),'procurement-shared-'));const processes=new Set();let browser;
/** Start exactly one isolated service and verify its actual data directory. */
async function start(mode,port) {
  const args=['node_modules/vite/bin/vite.js',...(mode==='preview'?['preview']:[]),'--host','127.0.0.1','--port',String(port),'--strictPort'];
  const child=spawn(process.execPath,args,{env:{...process.env,PROCUREMENT_DATA_DIR:directory},stdio:'pipe'});processes.add(child);
  let logs='';child.stderr.on('data',b=>logs+=b);child.stdout.on('data',b=>logs+=b);
  const origin=`http://127.0.0.1:${port}`;
  for(let i=0;i<100;i++){
    if(child.exitCode!==null)throw new Error(logs);
    try{const response=await fetch(origin+'/api/procurement/storage');if(response.ok){const info=await response.json();assert.equal(info.directory,directory);assert.notEqual(info.directory,resolve('.data'));return {child,origin};}}catch(error){logs=String(error);}
    await delay(100);
  }
  throw new Error('storage service did not start: '+logs);
}
/** Wait for our process to release SQLite handles and its listening port. */
async function stop(service) {const closed=new Promise(resolve=>service.child.once('close',resolve));service.child.kill();await closed;processes.delete(service.child);}
/** Send JSON through the production local API and fail on real server errors. */
async function api(origin,path,data) {
  const response=await fetch(origin+'/api/procurement/'+path,data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  const result=await response.json();if(!response.ok)throw new Error(result.error);return result;
}
/** Use the visible login fields, retaining independent browser sessions. */
async function login(page,origin){await page.goto(origin);await page.getByLabel('账号').fill('admin');await page.getByLabel('密码',{exact:true}).fill('admin');await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByRole('heading',{name:'工作首页',exact:true}).waitFor();}
try {
  const dev=await start('dev',4297);let preview=await start('preview',4296);
  browser=await chromium.launch();const a=await browser.newContext();const b=await browser.newContext();const original=await a.newPage();const other=await b.newPage();
  const legacy={...newRequest(),id:'legacy-007',code:'202611080007',title:'原浏览器申请007',costCenter:'研发',department:'研发部',date:'2027-02-01',purpose:'保留现有数据',supplierId:'SUP-1',supplier:'青禾办公用品',revision:2,updated:'2026-11-08T10:00:00Z',lines:[{name:'设备',specification:'标准',quantity:1,price:200}],details:{type:'物资',address:'上海',contact:'张三',installation:false,installationNotes:''},history:[{id:'history-id',at:'2026-11-08T09:00:00Z',stage:'部门',action:'驳回',actor:'原审批人',comment:'原审批意见'}],files:[]};
  const raw=new DatabaseSync(join(directory,'procurement.sqlite'));raw.exec('PRAGMA busy_timeout=5000;BEGIN IMMEDIATE');
  const {files,...data}=legacy;
  raw.prepare('INSERT INTO requests VALUES(?,?,?)').run(legacy.id,legacy.code,JSON.stringify(data));
  raw.prepare('INSERT INTO attachments VALUES(?,?,?,?,?,?)').run(legacy.id,0,'quote.txt','text/plain',123,Buffer.from('原始报价内容'));
  raw.prepare('INSERT INTO sequences VALUES(?,?) ON CONFLICT(day) DO UPDATE SET value=MAX(value,excluded.value)').run('20261108',9);
  raw.exec('COMMIT');raw.close();
  await login(original,dev.origin);
  assert.equal(await original.getByRole('link',{name:'迁移浏览器数据',exact:true}).count(),0);
  assert.equal(await original.getByText('数据管理',{exact:true}).count(),0);
  for(const path of ['import','import/preview']){const response=await fetch(dev.origin+'/api/procurement/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(response.status,404);}
  const imported=await api(preview.origin,'requests/legacy-007');assert.equal(imported.code,legacy.code);assert.deepEqual(imported.history,legacy.history);assert.equal(Buffer.from(imported.files[0].base64,'base64').toString(),'原始报价内容');
  console.log('PASS existing SQLite record: original code/history/attachment retained; migration UI and APIs removed');
  await login(other,preview.origin);await other.getByRole('link',{name:'采购申请',exact:true}).click();await other.getByRole('textbox',{name:'搜索申请单',exact:true}).fill(legacy.code);await other.getByRole('row').filter({hasText:legacy.title}).waitFor();
  await other.getByRole('row').filter({hasText:legacy.title}).getByRole('button',{name:'继续编辑',exact:true}).click();await other.getByPlaceholder('例如：研发工作站采购').fill('另一浏览器修改007');await other.getByRole('button',{name:'保存草稿',exact:true}).click();await other.getByRole('row').filter({hasText:'另一浏览器修改007'}).waitFor();
  await original.getByRole('link',{name:'采购申请',exact:true}).click();await original.getByRole('textbox',{name:'搜索申请单',exact:true}).fill(legacy.code);await original.getByRole('row').filter({hasText:'另一浏览器修改007'}).waitFor();
  const downloadPage=other;await downloadPage.getByRole('row').filter({hasText:'另一浏览器修改007'}).getByRole('button',{name:'继续编辑',exact:true}).click();await downloadPage.getByRole('button',{name:'下一步',exact:true}).click();await downloadPage.getByRole('button',{name:'下一步',exact:true}).click();await downloadPage.getByRole('button',{name:'下一步',exact:true}).click();
  const downloaded=downloadPage.waitForEvent('download');await downloadPage.getByRole('button',{name:'下载 quote.txt',exact:true}).click();const file=await downloaded;const stream=await file.createReadStream();let bytes=[];for await(const chunk of stream)bytes.push(chunk);assert.equal(Buffer.concat(bytes).toString(),'原始报价内容');
  console.log('PASS distinct browser contexts + dev/preview share edits and download exact attachment bytes');
  const forms=Array.from({length:20},(_,i)=>({...newRequest(),title:`跨进程并发${i}`,files:[]}));
  await Promise.all(forms.map((form,i)=>api(i%2?dev.origin:preview.origin,'requests/save',{form,operation:'create'})));
  const records=await api(preview.origin,'requests');assert.equal(new Set(records.map(r=>r.code)).size,records.length);
  for(const form of forms)assert.equal(records.filter(r=>r.id===form.id).length,1);
  await stop(preview);preview=await start('preview',4296);assert.equal((await api(preview.origin,'requests/legacy-007')).title,'另一浏览器修改007');assert.equal((await api(preview.origin,'requests/legacy-007')).files[0].base64,imported.files[0].base64);
  const added={...newRequest(),title:'重启后新增',files:[]};await api(preview.origin,'requests/save',{form:added,operation:'create'});const last=await api(dev.origin,'requests/'+added.id);assert.ok(!records.some(r=>r.code===last.code));
  const invalid=await fetch(preview.origin+'/api/procurement/requests/save',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(invalid.status,409);
  const forbidden=await fetch(preview.origin+'/api/procurement/reset',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://other.example'},body:'{}'});assert.equal(forbidden.status,403);
  assert.equal((await fetch(dev.origin+'/.data/procurement.sqlite')).status,404);
  console.log('PASS two service processes: concurrent unique codes, restart persistence, invalid request and cross-site write rejection, private database file');
}finally{await browser?.close();for(const child of processes){const closed=new Promise(resolve=>child.once('close',resolve));child.kill();await closed;}await rm(directory,{recursive:true,force:true});}
