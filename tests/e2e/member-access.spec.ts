import {test,expect} from '@playwright/test';
import {mockConsole} from './mock-api';
test('member has a clean inbox and no model or prompt configuration',async({page},info)=>{
 await mockConsole(page,{conversations:[]});
 await page.route('**/api/auth/session',r=>r.fulfill({json:{authenticated:true,username:'yzmy',role:'member'}}));
 await page.route('**/api/main*',r=>r.fulfill({json:{mode:'tasks',tasks:[],nextBefore:null}}));
 const calls:string[]=[];page.on('request',r=>calls.push(new URL(r.url()).pathname));
 await page.goto('/');await expect(page.getByRole('heading',{name:'主会话',exact:true})).toBeVisible();
 if(info.project.name.startsWith('mobile'))await page.getByRole('button',{name:'打开导航'}).click();
 await expect(page.locator('.sidebar').getByRole('button',{name:'任务列表',exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'配置',exact:true})).toHaveCount(0);
 expect(calls.filter(s=>/^\/api\/(settings|models|capabilities)/.test(s))).toEqual([]);
 await expect(page.locator('body')).not.toContainText(/GPT-6|SOUL.md|推理强度/);
 if(info.project.name.startsWith('mobile')){await page.getByRole('button',{name:'关闭导航'}).click();await page.setViewportSize({width:360,height:844});}
 expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
 await page.screenshot({path:info.outputPath('member.png')});
});
test('login accepts the supplied account name',async({page})=>{
 let authenticated=false;let body:any;
 await mockConsole(page,{conversations:[]});
 await page.route('**/api/auth/session',r=>r.fulfill({json:{authenticated,username:authenticated?'yzmy':null,role:authenticated?'member':null}}));
 await page.route('**/api/main*',r=>r.fulfill({json:{mode:'tasks',tasks:[],nextBefore:null}}));
 await page.route('**/api/auth/login',async r=>{body=r.request().postDataJSON();authenticated=true;await r.fulfill({json:{ok:true,username:'yzmy',role:'member'}});});
 await page.goto('/login');await expect(page.getByLabel('账号',{exact:true})).toHaveValue('');await expect(page.getByLabel('账号',{exact:true})).toBeFocused();
 const account=page.getByLabel('账号',{exact:true});await expect(account).toHaveAttribute('autocapitalize','none');await expect(account).toHaveAttribute('autocorrect','off');await expect(account).toHaveAttribute('spellcheck','false');await page.getByLabel('账号',{exact:true}).fill('yzmy');await page.getByLabel('密码',{exact:true}).fill('test-password');await page.getByRole('button',{name:'登录',exact:true}).click();
 await expect(page.getByRole('heading',{name:'主会话',exact:true})).toBeVisible();expect(body).toEqual({username:'yzmy',password:'test-password'});expect(new URL(page.url()).pathname).toBe('/u/yzmy');
});
test('each account has its own address; another account\'s address says whose it is',async({page},info)=>{
 let authenticated=true;
 await mockConsole(page,{conversations:[]});
 await page.route('**/api/auth/session',r=>r.fulfill({json:{authenticated,username:authenticated?'owner':null,role:authenticated?'owner':null}}));
 await page.route('**/api/main*',r=>r.fulfill({json:{mode:'tasks',tasks:[],nextBefore:null}}));
 await page.route('**/api/auth/logout',async r=>{authenticated=false;await r.fulfill({json:{ok:true}});});
 const main=page.getByRole('heading',{name:'主会话',exact:true});
 // The root becomes the signed-in account's own address, keeping the query.
 await page.goto('/?x=1');await expect(main).toBeVisible();
 expect(new URL(page.url()).pathname+new URL(page.url()).search).toBe('/u/owner?x=1');
 // Another account's address shows none of the signed-in account's data, and says so.
 await page.goto('/u/yzmy');
 const notice=page.getByRole('alert');
 await expect(notice).toContainText('这是 yzmy 的页面');await expect(notice).toContainText('当前登录的是 owner');
 await expect(main).toHaveCount(0);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
 await page.screenshot({path:info.outputPath('foreign.png')});
 await notice.getByRole('button',{name:'回到我的页面'}).click();
 await expect(main).toBeVisible();expect(new URL(page.url()).pathname).toBe('/u/owner');
 // Switching: sign out there, and the login form is ready for the account the address names.
 await page.goto('/u/yzmy');await page.getByRole('button',{name:'退出并登录 yzmy'}).click();
 await expect(page.getByLabel('账号',{exact:true})).toHaveValue('yzmy');expect(new URL(page.url()).pathname).toBe('/u/yzmy');
});
const notReady=(sandbox:object)=>({agent:{sessionReady:false,account:null,activeTurnId:null,activeConversationId:null,queuedTurns:0,lastError:'服务正在连接'},hostAuth:{ok:true},sandbox,workspaceOrigin:'http://127.0.0.1'} as never);
for(const [state,sandbox] of [['waking from idle',{running:false,healthy:false,idle:'waking'}],['still starting',{running:true,healthy:false,idle:null,setupError:null}]] as const)
test(`an environment ${state} says nothing, and the visible console sends its heartbeat`,async({page},info)=>{
 await mockConsole(page,{conversations:[],status:notReady(sandbox)});
 await page.route('**/api/auth/session',r=>r.fulfill({json:{authenticated:true,username:'yzmy',role:'member'}}));
 await page.route('**/api/main*',r=>r.fulfill({json:{mode:'tasks',tasks:[],nextBefore:null}}));
 let beats=0;await page.route('**/api/presence',r=>{beats+=1;return r.fulfill({json:{ok:true}});});
 await page.goto('/');
 // The status has arrived: the console looks as it does when everything is up.
 await expect(page.locator('.sidebar-foot')).toContainText('智能体在线');
 await expect(page.locator('.banner')).toHaveCount(0);
 await expect(page.locator('body')).not.toContainText(/休眠|唤醒|未就绪|正在连接/);
 await expect.poll(()=>beats).toBeGreaterThan(0);
 if(info.project.name.startsWith('mobile'))await page.setViewportSize({width:360,height:844});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
 await page.screenshot({path:info.outputPath('quiet.png')});
});
test('a start that failed is still reported',async({page})=>{
 await mockConsole(page,{conversations:[],status:notReady({running:false,healthy:false,idle:null,setupError:'服务正在连接'})});
 await page.route('**/api/auth/session',r=>r.fulfill({json:{authenticated:true,username:'yzmy',role:'member'}}));
 await page.route('**/api/main*',r=>r.fulfill({json:{mode:'tasks',tasks:[],nextBefore:null}}));
 await page.goto('/');
 await expect(page.locator('.banner.error')).toHaveText('智能体暂未就绪：服务正在连接。消息仍会保留。');
 await expect(page.locator('.sidebar-foot')).toContainText('正在连接智能体');
});
