import { test, expect } from '@playwright/test';
import { mockConsole } from './mock-api';
import type { UsageReport } from '../../src/common/usage';

test('owner daily usage trends, user/range filters, detail and retry at desktop and phone widths', async ({page},info) => {
  await mockConsole(page,{conversations:[]});
  await page.route('**/api/auth/session',r=>r.fulfill({json:{authenticated:true,username:'owner',role:'owner'}}));
  await page.route('**/api/main*',r=>r.fulfill({json:{mode:'tasks',tasks:[],nextBefore:null}}));
  let fail=false;
  await page.route('**/api/usage*',r=>{
    if(fail)return r.fulfill({status:503,json:{error:'unavailable',message:'暂时无法读取'}});
    const days=Number(new URL(r.request().url()).searchParams.get('days'));
    const dates=Array.from({length:days},(_,i)=>new Date(Date.UTC(2026,9,3)-(days-1-i)*86400000).toISOString().slice(0,10));
    const report:UsageReport={days,dates,timezone:'America/Los_Angeles',generatedAt:Date.now(),accounts:[['owner_1','owner',100],['m','yzmy',200]].map(([id,username,n])=>({id:String(id),username:String(username),role:username==='owner'?'owner':'member',available:true,collectionStartedAt:Date.now(),firstRecordAt:Date.now(),days:dates.map(date=>({date,input:Number(n),output:10,cached:50,cacheWrite:0,total:Number(n)+10})),totals:{input:Number(n)*days,output:10*days,cached:50*days,cacheWrite:0,total:(Number(n)+10)*days}}))};
    return r.fulfill({json:report});
  });
  await page.goto('/');await expect(page.getByRole('heading',{name:'主会话',exact:true})).toBeVisible();
  if(info.project.name.startsWith('mobile'))await page.getByRole('button',{name:'打开导航'}).click();
  await page.getByRole('button',{name:'用量看板',exact:true}).click();
  await expect(page.getByRole('heading',{name:'用量看板',exact:true})).toBeVisible();
  await expect(page.locator('.usage-metrics').first()).toContainText('9,600');
  await expect(page.getByRole('img',{name:'各用户每天的 token 用量趋势'})).toBeVisible();
  await page.getByLabel('时间范围').selectOption('7');await expect(page.locator('.usage-metrics')).toContainText('2,240');
  await page.getByRole('combobox',{name:'用户',exact:true}).selectOption('m');await expect(page.locator('.usage-metrics')).toContainText('1,470');
  expect(await page.locator('.usage-chart polyline').count()).toBe(1);
  await page.getByText('每日明细 · yzmy',{exact:true}).click();await expect(page.locator('details tbody tr')).toHaveCount(7);
  fail=true;await page.getByRole('button',{name:'刷新用量'}).click();await expect(page.getByRole('alert')).toContainText('暂时无法读取');
  fail=false;await page.getByRole('button',{name:'刷新用量'}).click();await expect(page.getByRole('alert')).toHaveCount(0);
  for(const width of info.project.name.startsWith('mobile')?[390,360]:[1440]){
    await page.setViewportSize({width,height:info.project.name.startsWith('mobile')?844:900});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({path:info.outputPath(`usage-${width}.png`)});
  }
});
test('member sidebar has no dashboard and never requests its API',async({page},info)=>{
  await mockConsole(page,{conversations:[]});await page.route('**/api/auth/session',r=>r.fulfill({json:{authenticated:true,username:'yzmy',role:'member'}}));
  await page.route('**/api/main*',r=>r.fulfill({json:{mode:'tasks',tasks:[],nextBefore:null}}));
  const requests:string[]=[];page.on('request',r=>requests.push(r.url()));await page.goto('/');await expect(page.getByRole('heading',{name:'主会话',exact:true})).toBeVisible();
  if(info.project.name.startsWith('mobile'))await page.getByRole('button',{name:'打开导航'}).click();
  await expect(page.getByRole('button',{name:'用量看板',exact:true})).toHaveCount(0);expect(requests.some(u=>u.includes('/api/usage'))).toBe(false);
});
