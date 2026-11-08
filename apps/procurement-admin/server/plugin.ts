import type { Plugin, Connect } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { ProcurementStore } from './store.ts';
import { ProcurementError } from '../src/domain.ts';
import { object, text, integer, choice, supplier, request } from './validation.ts';

/** Read a bounded JSON request; a malformed or oversized body never reaches storage. */
async function body(req:IncomingMessage):Promise<Record<string,unknown>> {
  const chunks:Buffer[]=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>64*1024*1024)throw new ProcurementError('请求超过 64 MiB，请减少附件大小');chunks.push(Buffer.from(chunk));}
  try{return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));}
  catch(error){if(error instanceof SyntaxError)throw new ProcurementError('请求 JSON 格式无效');throw error;}
}
/** Write consistent JSON and prevent stale browser caches across shared updates. */
function send(res:ServerResponse,status:number,value:unknown) {res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(value));}
/** Reuse one SQLite-backed API in both Vite dev and preview, opening no database during build. */
export function sharedStorage():Plugin {
  const project=fileURLToPath(new URL('../',import.meta.url));
  const directory=process.env.PROCUREMENT_DATA_DIR ? resolve(project,process.env.PROCUREMENT_DATA_DIR) : resolve(project,'.data');
  let store:ProcurementStore|undefined;
  const middleware:Connect.NextHandleFunction=(req,res,next)=>{
    if(req.url?.startsWith('/.data/')){send(res,404,{error:'文件不可通过静态地址访问'});return;}
    if(!req.url?.startsWith('/api/procurement/')){next();return;}
    void (async()=>{
      if(req.method!=='GET'){
        const origin=req.headers.origin;
        if(origin&&new URL(origin).host!==req.headers.host){send(res,403,{error:'禁止跨站写入'});return;}
        if(!req.headers['content-type']?.startsWith('application/json')){send(res,415,{error:'请求必须使用 application/json'});return;}
      }
      store ??= new ProcurementStore(resolve(directory,'procurement.sqlite'));
      const path=new URL(req.url!,'http://localhost').pathname.slice('/api/procurement/'.length);
      if(req.method==='GET'){
        if(path==='requests'){send(res,200,store.listRequests());return;}
        if(path.startsWith('requests/')){send(res,200,store.getRequest(decodeURIComponent(path.slice(9))));return;}
        if(path==='suppliers'){send(res,200,store.listSuppliers());return;}
        if(path==='storage'){send(res,200,{directory,database:resolve(directory,'procurement.sqlite')});return;}
      }
      if(req.method==='POST'){
        const data=await body(req);
        if(path==='requests/save')store.saveRequest(request(data.form),choice(data.operation,['create','update'],'保存方式'));
        else if(path==='requests/delete')store.deleteRequest(text(data.id,'ID'),integer(data.revision,'版本'));
        else if(path==='requests/review')store.reviewRequest(text(data.id,'ID'),integer(data.revision,'版本'),choice(data.stage,['部门','财务','完成'],'审批节点'),choice(data.action,['通过','驳回'],'审批动作'),text(data.comment,'审批意见'));
        else if(path==='suppliers/save')store.saveSupplier(supplier(data.supplier));
        else if(path==='suppliers/delete')store.deleteSupplier(text(data.id,'ID'));
        else if(path==='reset')store.reset();
        else {send(res,404,{error:'接口不存在'});return;}
        send(res,200,{ok:true});return;
      }
      send(res,404,{error:'接口不存在'});
    })().catch((error:unknown)=>{console.error('[procurement storage]',req.method,req.url,error);send(res,error instanceof ProcurementError?409:500,{error:error instanceof Error?error.message:String(error)});});
  };
  const install=(server:{middlewares:Connect.Server;httpServer?:{once:(event:string,listener:()=>void)=>unknown}|null})=>{
    server.middlewares.use(middleware);server.httpServer?.once('close',()=>{store?.close();store=undefined;});
  };
  return {name:'vite-plugin-procurement-storage',configureServer:install,configurePreviewServer:install};
}
