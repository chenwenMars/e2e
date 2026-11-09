import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcurementStore } from '../server/store.ts';
import { newRequest } from '../src/domain.ts';
import { supplierSeeds, type StoredRequest } from '../src/storage-model.ts';

function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'procurement-store-'));
  return {file:join(dir,'data.sqlite'),clean:()=>rmSync(dir,{recursive:true,force:true})};
}
function draft(title='共享草稿'): StoredRequest { return {...newRequest(),title,files:[]}; }
test('两个连接共享数据，重启保留编码、版本和附件，旧编辑不能覆盖',()=>{
  const f=fixture();const a=new ProcurementStore(f.file);const b=new ProcurementStore(f.file);
  try {
    const input=draft();input.files=[{name:'报价.txt',type:'text/plain',lastModified:1,base64:Buffer.from('原始附件').toString('base64')}];
    a.saveRequest(input,'create');const saved=b.getRequest(input.id);
    assert.match(saved.code,/^\d{12}$/);assert.deepEqual(saved.files,input.files);
    b.saveRequest({...saved,title:'另一浏览器修改'},'update');
    assert.equal(a.getRequest(input.id).title,'另一浏览器修改');
    assert.throws(()=>a.saveRequest(saved,'update'),/已变更/);
    b.close();const reopened=new ProcurementStore(f.file);
    try {assert.equal(reopened.getRequest(input.id).code,saved.code);assert.deepEqual(reopened.getRequest(input.id).files,input.files);}finally{reopened.close();}
    a.deleteRequest(input.id,2);assert.throws(()=>a.saveRequest({...saved,revision:2},'update'),/已删除/);
  }finally{a.close();b.close();f.clean();}
});
test('已迁移的 SQLite 数据可直接读取，原编码、附件和流水高水位保留',()=>{
  const f=fixture();const initialized=new ProcurementStore(f.file,{seed:false});initialized.close();
  const row={...draft('demo1'),code:'202611080007',revision:1,status:'已提交' as const,supplierId:'SUP-4',history:[{id:'event',at:'2026-11-08T10:00:00Z',action:'提交' as const,stage:'部门' as const,actor:'admin',comment:'提交采购申请'}]};
  const raw=new DatabaseSync(f.file);
  for(const s of supplierSeeds())raw.prepare('INSERT INTO suppliers VALUES(?,?,?)').run(s.id,s.name,JSON.stringify(s));
  const {files,currency,costCenter,exchangeRate,...data}=row;
  raw.prepare('INSERT INTO requests VALUES(?,?,?)').run(row.id,row.code,JSON.stringify(data));
  raw.prepare('INSERT INTO attachments VALUES(?,?,?,?,?,?)').run(row.id,0,'quote.txt','text/plain',1,Buffer.from('原始报价'));
  raw.prepare('INSERT INTO sequences VALUES(?,?)').run('20261108',20);raw.close();
  const store=new ProcurementStore(f.file);
  try{const saved=store.getRequest(row.id);assert.equal(saved.currency,'CNY');assert.equal(saved.costCenter,'');assert.equal(saved.exchangeRate,null);assert.equal(saved.code,row.code);assert.equal(saved.status,row.status);assert.deepEqual(saved.history,row.history);assert.equal(Buffer.from(saved.files[0]!.base64,'base64').toString(),'原始报价');assert.equal(store.sequence('20261108'),20);assert.equal(store.listRequests().length,1);}
  finally{store.close();f.clean();}
});
test('损坏文件不能当成空数据初始化',()=>{
  const f=fixture();writeFileSync(f.file,'corrupt database');try{assert.throws(()=>new ProcurementStore(f.file));}finally{f.clean();}
});
