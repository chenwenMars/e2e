import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const require=createRequire(import.meta.url);const {chromium}=createRequire(require.resolve('@e2e-dev/web'))('playwright-core');
const directory=await mkdtemp(join(tmpdir(),'procurement-layout-'));
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','preview','--host','127.0.0.1','--port','4298','--strictPort'],{stdio:'pipe',env:{...process.env,PROCUREMENT_DATA_DIR:directory}});
let logs='';server.stderr.on('data',b=>logs+=b);let browser;
try {
  for(let i=0;i<100;i++){if(server.exitCode!==null)throw new Error(logs);try{if((await fetch('http://127.0.0.1:4298')).ok)break;}catch(error){logs=error.message;}await delay(100);}
  browser=await chromium.launch();const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await mkdir('.e2e/ui/shared-storage',{recursive:true});
  await page.goto('http://127.0.0.1:4298');await page.getByLabel('账号').fill('admin');await page.getByLabel('密码',{exact:true}).fill('admin');await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByRole('heading',{name:'工作首页',exact:true}).waitFor();
  for(const width of [1440,768,375]){
    await page.setViewportSize({width,height:1000});
    for(const [route,heading] of [['home','工作首页'],['requests','采购申请'],['suppliers','供应商名录'],['approvals','审批工作台'],['requests/new','创建采购申请']]){
      await page.goto(`http://127.0.0.1:4298/#/${route}`);await page.getByRole('heading',{name:heading,exact:true}).waitFor();
      await page.waitForTimeout(350); // Let Element Plus entry transitions settle before visual evidence.
      await page.screenshot({path:`.e2e/ui/shared-storage/${width}-${route.replace('/','-')}.png`,fullPage:true});
      const dimensions=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));assert.ok(dimensions.scroll<=dimensions.width,`overflow ${width}/${route}: ${JSON.stringify(dimensions)}`);
    }
    console.log(`PASS ${width}px: all console pages render without page overflow`);
  }
  await page.keyboard.press('Tab');assert.ok(await page.evaluate(()=>document.activeElement!==document.body),'keyboard focus must enter a control');
  assert.deepEqual(errors,[]);console.log('PASS keyboard focus and no uncaught runtime errors');
}finally{await browser?.close();const closed=new Promise(resolve=>server.once('close',resolve));server.kill();await closed;await rm(directory,{recursive:true,force:true});}
