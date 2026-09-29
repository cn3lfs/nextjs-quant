import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
const { chromium } = createRequire(join(homedir(), '.agent-tools/playwright/package.json'))('playwright');
const browser = await chromium.launch({channel:'chrome',headless:true});
try {
 const page=await browser.newPage({viewport:{width:1280,height:900}});
 await page.goto('http://127.0.0.1:3224/cls-review');
 const list=page.getByLabel('报告列表',{exact:true});
 await list.getByRole('button').first().waitFor();
 let held=false, release;
 const gate=new Promise(resolve=>{release=resolve;});
 await page.route('**/api/trpc/**',async route=>{
  if(route.request().url().includes('clsReviewReportPage')&&!held){held=true;await gate;}
  await route.continue();
 });
 await page.getByLabel('报告标题',{exact:true}).fill('合成报告 99');
 await page.getByRole('button',{name:'查询报告',exact:true}).click();
 await page.getByText('正在更新报告列表，暂时显示上次结果。',{exact:true}).waitFor();
 assert.equal(await list.getByRole('button').first().isDisabled(),true);
 release();
 await list.getByRole('button',{name:/^合成报告 999 ·/}).waitFor();
 await page.waitForFunction(()=>!document.body.innerText.includes('正在更新报告列表，暂时显示上次结果。'));
 assert.equal(await list.getByRole('button').first().isEnabled(),true);
 const refreshed=page.waitForResponse(r=>r.url().includes('clsReviewReportPage')&&r.status()===200);
 await page.getByRole('button',{name:'查询报告',exact:true}).click();
 await refreshed;
 await page.screenshot({path:join(tmpdir(),'logs/quant-cls-review/final-1280.png'),fullPage:true});
 writeFileSync(join(tmpdir(),'logs/quant-cls-review/filter-refresh.json'),JSON.stringify({checks:['delayed filter preserves disabled previous results','same submitted filter performs fresh request','1280px layout'],passed:true},null,2));
 console.log('Filter placeholder and explicit refresh passed');
} finally {await browser.close();}
