import {test,expect} from '@playwright/test';
import {mockConsole} from './mock-api';

test('terminal lists live session IDs, refreshes, copies, handles failures and stops polling off-tab',async({page},info)=>{
  await mockConsole(page,{conversations:[]});
  await page.route('**/api/main*',r=>r.fulfill({json:{mode:'tasks',tasks:[],nextBefore:null}}));
  let reads=0,fail=false;
  let sessions=[{id:'shell-agent-1234567890123456789012345678901234567890',status:'running',workingDir:'/home/gem/workspace/tasks/demo',lastUsedAt:'2026-09-29T01:00:00Z'},{id:'shell-idle',status:'completed',workingDir:'/home/gem/workspace',lastUsedAt:null}];
  await page.route('**/api/sandbox/shell-sessions',r=>{reads++;return r.fulfill({status:fail?502:200,json:fail?{message:'无法读取会话'}:{sessions}});});
  await page.addInitScript(()=>Object.defineProperty(navigator,'clipboard',{value:{writeText:async(value:string)=>{(window as any).copied=value;}}}));
  await page.goto('/');
  if(info.project.name.startsWith('mobile')) await page.getByRole('button',{name:'打开导航'}).click();
  await page.locator('.sidebar').getByRole('button',{name:'工作区',exact:true}).click();
  expect(reads).toBe(0);await page.getByRole('tab',{name:'终端',exact:true}).click();
  const panel=page.getByRole('region',{name:'活跃 Shell 会话'});await expect(panel).toContainText('活跃会话 · 2');await expect(panel).toContainText('运行中');await expect(panel).toContainText('空闲');
  await panel.getByRole('button',{name:'复制 session ID shell-idle',exact:true}).click();expect(await page.evaluate(()=>(window as any).copied)).toBe('shell-idle');
  sessions=[{...sessions[0]!,status:'completed'}];await expect(panel).toContainText('活跃会话 · 1');
  fail=true;await page.getByRole('button',{name:'刷新终端会话'}).click();await expect(panel.getByRole('alert')).toContainText('上次读取结果');
  fail=false;sessions=[];await page.getByRole('button',{name:'刷新终端会话'}).click();await expect(panel).toContainText('暂无活跃');
  sessions=[{id:'shell-long-abcdefghijklmnopqrstuvwxyz0123456789',status:'running',workingDir:'/home/gem/workspace/long-project-name',lastUsedAt:null}];await page.getByRole('button',{name:'刷新终端会话'}).click();await expect(panel).toContainText('shell-long');
  if(info.project.name.startsWith('mobile')) await page.setViewportSize({width:360,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);await page.screenshot({path:info.outputPath('terminal-sessions.png')});
  await page.getByRole('tab',{name:'文件',exact:true}).click();const before=reads;
  await page.waitForTimeout(5500);expect(reads).toBe(before);await expect(panel).toHaveCount(0);
});
