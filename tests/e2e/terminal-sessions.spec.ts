import {test,expect} from '@playwright/test';
import {mockConsole} from './mock-api';

test('compact terminal picker switches, creates and closes sessions while preserving failed closes and off-tab sessions',async({page},info)=>{
  await mockConsole(page,{conversations:[]});
  await page.route('**/api/main*',r=>r.fulfill({json:{mode:'tasks',tasks:[],nextBefore:null}}));
  let reads=0,fail=false,failClose=false;
  const running='shell-agent-1234567890123456789012345678901234567890';
  let sessions=[{id:running,status:'running',workingDir:'/home/gem/workspace/tasks/demo',lastUsedAt:'2026-09-29T01:00:00Z'},{id:'shell-idle',status:'completed',workingDir:'/home/gem/workspace',lastUsedAt:null as string|null}];
  const deleted:string[]=[];const paths:string[]=[];
  await page.route('**/api/workspace/ticket',r=>{const path=r.request().postDataJSON().next;paths.push(path);return r.fulfill({json:{ticket:'t',origin:'http://127.0.0.1:4289',url:`http://127.0.0.1:4289${path}`,expiresAt:Date.now()+60000}});});
  await page.route('http://127.0.0.1:4289/terminal**',r=>r.fulfill({contentType:'text/html',body:'<html><body style="background:#1e1e1e;color:white">Connected terminal</body></html>'}));
  await page.route('**/api/sandbox/shell-sessions',r=>{
    if(r.request().method()==='POST'){sessions.push({id:'shell-new',status:'ready',workingDir:'/home/gem/workspace',lastUsedAt:null});return r.fulfill({status:201,json:{id:'shell-new'}});}
    reads++;return r.fulfill({status:fail?502:200,json:fail?{message:'无法读取会话'}:{sessions}});
  });
  await page.route('**/api/sandbox/shell-sessions/*',r=>{
    const id=decodeURIComponent(new URL(r.request().url()).pathname.split('/').at(-1)!);deleted.push(id);
    if(failClose)return r.fulfill({status:502,json:{message:'关闭失败，请核对'}});
    sessions=sessions.filter(s=>s.id!==id);return r.fulfill({json:{ok:true}});
  });
  await page.addInitScript(()=>Object.defineProperty(navigator,'clipboard',{value:{writeText:async(value:string)=>{(window as any).copied=value;}}}));
  await page.goto('/');
  if(info.project.name.startsWith('mobile'))await page.getByRole('button',{name:'打开导航'}).click();
  await page.locator('.sidebar').getByRole('button',{name:'工作区',exact:true}).click();
  expect(reads).toBe(0);await page.getByRole('tab',{name:'终端',exact:true}).click();
  const panel=page.getByRole('region',{name:'活跃 Shell 会话'});const picker=page.getByRole('button',{name:'切换终端会话'});const frame=page.locator('iframe[title="终端"]');
  await expect(frame).toHaveAttribute('src',new RegExp(running));await expect(picker).toHaveAttribute('aria-expanded','false');
  expect((await panel.boundingBox())!.height).toBeLessThan(90);
  const frameHeight=(await frame.boundingBox())!.height;
  await picker.click();await expect(panel).toContainText('终端会话 · 2');
  expect((await frame.boundingBox())!.height).toBe(frameHeight);
  await panel.getByRole('button',{name:'复制 session ID shell-idle',exact:true}).click();expect(await page.evaluate(()=>(window as any).copied)).toBe('shell-idle');
  await panel.getByRole('button',{name:'切换到终端 shell-idle',exact:true}).click();await expect(frame).toHaveAttribute('src',/session_id=shell-idle/);await expect(picker).toHaveAttribute('aria-expanded','false');
  expect(paths).toContain('/terminal?session_id=shell-idle');
  failClose=true;await page.getByRole('button',{name:'关闭当前终端'}).click();await expect(panel.getByRole('alert')).toContainText('关闭失败');await expect(frame).toHaveAttribute('src',/session_id=shell-idle/);
  failClose=false;await page.getByRole('button',{name:'关闭当前终端'}).click();await expect(frame).toHaveAttribute('src',new RegExp(running));
  await page.getByRole('button',{name:'关闭当前终端'}).click();await expect(panel.getByRole('alert')).toContainText('会终止');expect(deleted).not.toContain(running);
  await page.getByRole('button',{name:'取消',exact:true}).click();await expect(frame).toBeVisible();
  if(info.project.name.startsWith('mobile'))await page.setViewportSize({width:360,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
  await picker.click();await page.screenshot({path:info.outputPath('terminal-picker.png')});await picker.click();
  await page.getByRole('button',{name:'新建终端',exact:true}).click();await expect(frame).toHaveAttribute('src',/session_id=shell-new/);
  await page.getByRole('tab',{name:'文件',exact:true}).click();const before=reads;await page.waitForTimeout(5500);expect(reads).toBe(before);await expect(panel).toHaveCount(0);
  await page.getByRole('tab',{name:'终端',exact:true}).click();await expect(frame).toHaveAttribute('src',/session_id=shell-new/);
  fail=true;await page.getByRole('button',{name:'刷新终端会话'}).click();await expect(panel.getByRole('alert')).toContainText('上次读取结果');
  fail=false;await page.getByRole('button',{name:'关闭当前终端'}).click();await expect(frame).toHaveAttribute('src',new RegExp(running));
  await page.getByRole('button',{name:'关闭当前终端'}).click();await page.getByRole('button',{name:'确认关闭'}).click();await expect(page.getByText('暂无活跃终端',{exact:true})).toBeVisible();await expect(frame).toHaveCount(0);
  expect(deleted).toEqual(['shell-idle','shell-idle','shell-new',running]);
});
