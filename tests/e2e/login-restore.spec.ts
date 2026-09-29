import {test,expect,type Page} from '@playwright/test';
import {mockConsole} from './mock-api';
async function setup(page:Page){
 await mockConsole(page,{conversations:[]});
 await page.route('**/api/main*',r=>r.fulfill({json:{mode:'tasks',tasks:[],nextBefore:null}}));
}
const inbox=(page:Page)=>page.getByRole('heading',{name:'主会话',exact:true});
const password=(page:Page)=>page.getByPlaceholder('请输入访问密码');

test('valid HttpOnly cookie enters the main inbox even on /login without showing the form',async({page})=>{
 await setup(page);let logins=0;let cookieSeen=false;
 await page.context().addCookies([{name:'pa_session',value:'valid-fixture',url:'http://127.0.0.1:4288',httpOnly:true,sameSite:'Lax'}]);
 // WebKit omits Cookie from intercepted headers; the browser cookie jar drives this mock.
 await page.route('**/api/auth/session',async r=>{cookieSeen=(await page.context().cookies(r.request().url())).some(c=>c.name==='pa_session'&&c.value==='valid-fixture');return r.fulfill({json:{authenticated:cookieSeen,username:'owner'},headers:{'cache-control':'no-store'}});});
 page.on('request',r=>{if(r.url().endsWith('/api/auth/login'))logins++;});
 await page.addInitScript(()=>{(window as any).loginShown=false;new MutationObserver(()=>{if(document.querySelector('input[type="password"]'))(window as any).loginShown=true;}).observe(document,{childList:true,subtree:true});});
 await page.goto('/login');await expect(inbox(page)).toBeVisible();expect(new URL(page.url()).pathname).toBe('/');expect(cookieSeen).toBe(true);expect(logins).toBe(0);
 expect(await page.evaluate(()=>(window as any).loginShown)).toBe(false);expect(await page.evaluate(()=>document.cookie)).not.toContain('valid-fixture');
});

test('restored Safari page and foreground events discover a login from another tab',async({page})=>{
 await setup(page);let valid=false;let reads=0;
 await page.route('**/api/auth/session',r=>{reads++;return r.fulfill({json:{authenticated:valid,username:'owner'}});});
 await page.goto('/');await expect(password(page)).toBeVisible();const before=reads;
 valid=true;await page.evaluate(()=>{window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'));});
 await expect(inbox(page)).toBeVisible();expect(reads).toBeGreaterThan(before);await expect(password(page)).toHaveCount(0);
});

test('temporary session failure recovers online without losing a valid cookie or asking for a password',async({page})=>{
 await setup(page);let unavailable=true;
 await page.context().addCookies([{name:'pa_session',value:'valid-fixture',url:'http://127.0.0.1:4288',httpOnly:true,sameSite:'Lax'}]);
 await page.route('**/api/auth/session',r=>r.fulfill({status:unavailable?503:200,json:unavailable?{message:'稍后重试'}:{authenticated:true,username:'owner'}}));
 await page.goto('/');await expect(page.getByText('暂时无法验证登录状态，网络恢复后会自动重试。')).toBeVisible();
 expect((await page.context().cookies()).some(c=>c.name==='pa_session')).toBe(true);
 unavailable=false;await page.evaluate(()=>window.dispatchEvent(new Event('online')));await expect(inbox(page)).toBeVisible();
});

test('revoked cookies do not bypass login and signing out stays signed out',async({page},info)=>{
 await setup(page);let valid=false;let reads=0;
 await page.context().addCookies([{name:'pa_session',value:'expired-fixture',url:'http://127.0.0.1:4288',httpOnly:true,sameSite:'Lax'}]);
 await page.route('**/api/auth/session',r=>{reads++;return r.fulfill({json:{authenticated:valid,username:'owner'}});});
 await page.route('**/api/auth/login',r=>{valid=true;return r.fulfill({json:{ok:true}});});
 await page.route('**/api/auth/logout',r=>{valid=false;return r.fulfill({json:{ok:true}});});
 await page.goto('/');await expect(password(page)).toBeVisible();await password(page).fill('typed password');
 const before=reads;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await expect.poll(()=>reads).toBeGreaterThan(before);await expect(password(page)).toHaveValue('typed password');await expect(inbox(page)).toHaveCount(0);
 await page.getByRole('button',{name:'登录',exact:true}).click();await expect(inbox(page)).toBeVisible();
 if(info.project.name.startsWith('mobile'))await page.getByRole('button',{name:'打开导航'}).click();
 await page.locator('.sidebar').getByRole('button',{name:'退出登录',exact:true}).click();await expect(password(page)).toBeVisible();await expect(inbox(page)).toHaveCount(0);
});

test('visible login page retries periodically when another tab logs in without a focus event',async({page})=>{
 await page.clock.install();await setup(page);let valid=false;
 await page.route('**/api/auth/session',r=>r.fulfill({json:{authenticated:valid,username:'owner'}}));
 await page.goto('/');await expect(password(page)).toBeVisible();valid=true;await page.clock.runFor(15001);await expect(inbox(page)).toBeVisible();
});
