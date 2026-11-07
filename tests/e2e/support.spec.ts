import {test,expect} from '@playwright/test';
import {mockConsole} from './mock-api';
test('native account policy links use the system browser and preserve the dialog',async({page},info)=>{
  await page.addInitScript(()=>{
    (window as any).nativePolicyUrls=[];
    (window as any).aioDeviceBrowser={postMessage:(url:string)=>(window as any).nativePolicyUrls.push(url)};
  });
  await mockConsole(page,{conversations:[]});
  await page.route('**/api/auth/session',r=>r.fulfill({json:{authenticated:true,username:'member',role:'member'}}));
  await page.route('**/api/main*',r=>r.fulfill({json:{mode:'tasks',tasks:[],nextBefore:null}}));
  await page.goto('/'); await expect(page.getByRole('heading',{name:'主会话',exact:true})).toBeVisible();
  if(info.project.name.startsWith('mobile'))await page.getByRole('button',{name:'打开导航'}).click();
  await page.locator('.sidebar').getByRole('button',{name:'配置',exact:true}).click();
  await page.getByRole('navigation',{name:'配置项'}).getByRole('button',{name:'账户与隐私',exact:true}).click();
  await page.locator('.settings-card').getByRole('button',{name:'账户与隐私',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'账户与隐私',exact:true}),before=page.url();
  await dialog.getByLabel('说明',{exact:true}).fill('Keep this unsent request.');
  await dialog.getByRole('link',{name:'隐私政策',exact:true}).click();
  await dialog.getByRole('link',{name:'申请删除账户',exact:true}).click();
  expect(await page.evaluate(()=>(window as any).nativePolicyUrls.filter((url:string)=>/^https?:/.test(url)))).toEqual([new URL('/privacy.html',before).href,new URL('/account-deletion.html',before).href]);
  await expect(page).toHaveURL(before); await expect(dialog.getByRole('textbox',{name:'说明',exact:true})).toHaveValue('Keep this unsent request.');
  expect(page.context().pages()).toHaveLength(1);
});
test('native login policy links use the iOS browser bridge without leaving sign-in',async({page})=>{
  await page.addInitScript(()=>{
    (window as any).nativePolicyUrls=[];
    (window as any).webkit={messageHandlers:{aioDeviceBrowser:{postMessage:(url:string)=>(window as any).nativePolicyUrls.push(url)}}};
  });
  await mockConsole(page,{conversations:[]});
  await page.route('**/api/auth/session',r=>r.fulfill({json:{authenticated:false}}));
  await page.route('**/api/auth/google/pending',r=>r.fulfill({json:{enabled:true,pending:null}}));
  await page.goto('/login'); const before=page.url();
  await page.getByRole('link',{name:'隐私政策',exact:true}).click();
  await page.getByRole('link',{name:'账户与隐私',exact:true}).click();
  expect(await page.evaluate(()=>(window as any).nativePolicyUrls.filter((url:string)=>/^https?:/.test(url)))).toEqual([new URL('/privacy.html',before).href,new URL('/account-deletion.html',before).href]);
  await expect(page).toHaveURL(before); await expect(page.getByRole('button',{name:'使用 Google 登录 / 注册'})).toBeVisible();
  expect(page.context().pages()).toHaveLength(1);
});
test('members rate a reply: 👍 toggles, 👎 asks what was wrong and reporting it is optional',async({page},info)=>{
  await mockConsole(page,{conversations:[]});
  await page.route('**/api/auth/session',r=>r.fulfill({json:{authenticated:true,username:'member',role:'member'}}));
  await page.route('**/api/main*',r=>r.fulfill({json:{mode:'tasks',tasks:[{id:'reported-task',revision:1,title:'Test reply',text:'question',conversationId:'report-conv',status:'completed',result:'AI result',error:null,attachments:[],createdAt:1,completedAt:2}],nextBefore:null}}));
  const votes: unknown[] = []; let reports: unknown[] = [];
  await page.route('**/api/support/feedback/*',async r=>{const body=r.request().postDataJSON();votes.push(body);await r.fulfill({json:{rating:body.rating}});});
  await page.route('**/api/support/requests',async r=>{reports.push(r.request().postDataJSON());await r.fulfill({status:201,json:{id:'report-reference'}});});
  await page.goto('/');
  const up=page.getByRole('button',{name:'有帮助',exact:true}), down=page.getByRole('button',{name:'没帮助',exact:true});
  await up.click(); await expect(up).toHaveAttribute('aria-pressed','true');
  await up.click(); await expect(up).toHaveAttribute('aria-pressed','false');
  expect(votes).toEqual([{rating:'up'},{rating:null}]);

  // 👎 with nothing more to say: the vote stands, nothing is reported.
  await down.click(); await expect(down).toHaveAttribute('aria-pressed','true');
  let dialog=page.getByRole('dialog',{name:'这条回复哪里不好？'}); await expect(dialog).toContainText('说明可以不写');
  await dialog.getByRole('button',{name:'提交',exact:true}).click();
  await expect(dialog.getByRole('status')).toContainText('已记录你的反馈');
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
  expect(votes.at(-1)).toEqual({rating:'down'}); expect(reports).toEqual([]);

  // Again, now with a note and a report: a report needs the note, and gets a reference.
  await down.click(); await expect(down).toHaveAttribute('aria-pressed','false');
  await down.click();
  dialog=page.getByRole('dialog',{name:'这条回复哪里不好？'});
  await dialog.getByLabel('同时举报这条回复（违法、有害或不当内容）').check();
  await expect(dialog).toContainText('不会发送其他会话');
  await expect(dialog.getByRole('button',{name:'提交',exact:true})).toBeDisabled();
  await dialog.getByLabel('说明',{exact:true}).fill('This response contains unsafe instructions.');
  await page.screenshot({path:info.outputPath('dislike-report.png')});
  await dialog.getByRole('button',{name:'提交',exact:true}).click();
  await expect(dialog.getByRole('status')).toContainText('report-reference');
  expect(votes.at(-1)).toEqual({rating:'down',note:'This response contains unsafe instructions.'});
  expect(reports).toEqual([{kind:'content',taskId:'reported-task',note:'This response contains unsafe instructions.'}]);
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
  await expect(down).toHaveAttribute('aria-pressed','true');
});
test('on a phone the 👎 dialog shows whole, and sits above the keyboard once one is up',async({page},info)=>{
  test.skip(!info.project.name.startsWith('mobile'));
  await mockConsole(page,{conversations:[]});
  await page.route('**/api/auth/session',r=>r.fulfill({json:{authenticated:true,username:'member',role:'member'}}));
  await page.route('**/api/main*',r=>r.fulfill({json:{mode:'tasks',tasks:[{id:'reported-task',revision:1,title:'Test reply',text:'question',conversationId:'report-conv',status:'completed',result:'AI result',error:null,attachments:[],createdAt:1,completedAt:2}],nextBefore:null}}));
  await page.route('**/api/support/feedback/*',r=>r.fulfill({json:{rating:'down'}}));
  await page.goto('/');
  await page.getByRole('button',{name:'没帮助',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'这条回复哪里不好？'}), submit=dialog.getByRole('button',{name:'提交',exact:true});
  // The note is optional: no keyboard comes up on its own to cover the buttons.
  await expect(dialog.getByLabel('说明',{exact:true})).not.toBeFocused();
  await expect(submit).toBeInViewport();
  // A keyboard up (the iOS app reports the area it leaves): the whole dialog stays above it.
  await page.evaluate(()=>document.documentElement.style.setProperty('--keyboard-viewport','420px'));
  await expect.poll(async()=>{const b=(await dialog.boundingBox())!;return b.y+b.height;}).toBeLessThanOrEqual(420);
  const box=(await dialog.boundingBox())!; expect(box.y).toBeGreaterThanOrEqual(0);
  await submit.scrollIntoViewIfNeeded();
  expect((await submit.boundingBox())!.y+(await submit.boundingBox())!.height).toBeLessThanOrEqual(420);
  await page.screenshot({path:info.outputPath('dislike-keyboard.png')});
});
test('members can request deletion from settings without leaving the app',async({page},info)=>{
  await mockConsole(page,{conversations:[]});
  await page.route('**/api/auth/session',r=>r.fulfill({json:{authenticated:true,username:'member',role:'member'}}));
  await page.route('**/api/main*',r=>r.fulfill({json:{mode:'tasks',tasks:[],nextBefore:null}}));
  let sent: unknown; await page.route('**/api/support/requests',async r=>{sent=r.request().postDataJSON();await r.fulfill({status:201,json:{id:'delete-reference'}});});
  await page.goto('/'); await expect(page.getByRole('heading',{name:'主会话',exact:true})).toBeVisible();
  if(info.project.name.startsWith('mobile')) await page.getByRole('button',{name:'打开导航'}).click();
  await page.locator('.sidebar').getByRole('button',{name:'配置',exact:true}).click();
  await page.getByRole('navigation',{name:'配置项'}).getByRole('button',{name:'账户与隐私',exact:true}).click();
  await page.locator('.settings-card').getByRole('button',{name:'账户与隐私',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'账户与隐私',exact:true});
  // A question or feedback is what it sends unless deleting the account is chosen.
  await expect(dialog.getByRole('radio',{name:'咨询或反馈'})).toBeChecked();
  await expect(dialog.getByRole('button',{name:'提交',exact:true})).toBeVisible();
  await expect(dialog).not.toContainText('不会立即删除数据');
  await dialog.getByRole('radio',{name:'删除账户'}).check();
  await expect(dialog).toContainText('不会立即删除数据');
  await expect(dialog.getByRole('link',{name:'隐私政策'})).toHaveAttribute('href','/privacy.html');
  await dialog.getByLabel('说明',{exact:true}).fill('Please delete my account and data.');
  await dialog.getByRole('button',{name:'申请删除账户',exact:true}).click();
  await expect(dialog.getByRole('status')).toContainText('delete-reference');
  expect(sent).toEqual({kind:'deletion',note:'Please delete my account and data.'});
  if(info.project.name.startsWith('mobile'))await page.setViewportSize({width:360,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({path:info.outputPath('account-request.png')});
});
test('a question or feedback from settings goes to the administrator as one',async({page},info)=>{
  await mockConsole(page,{conversations:[]});
  await page.route('**/api/auth/session',r=>r.fulfill({json:{authenticated:true,username:'member',role:'member'}}));
  await page.route('**/api/main*',r=>r.fulfill({json:{mode:'tasks',tasks:[],nextBefore:null}}));
  let sent: unknown; await page.route('**/api/support/requests',async r=>{sent=r.request().postDataJSON();await r.fulfill({status:201,json:{id:'question-reference'}});});
  await page.goto('/'); await expect(page.getByRole('heading',{name:'主会话',exact:true})).toBeVisible();
  if(info.project.name.startsWith('mobile')) await page.getByRole('button',{name:'打开导航'}).click();
  await page.locator('.sidebar').getByRole('button',{name:'配置',exact:true}).click();
  await page.getByRole('navigation',{name:'配置项'}).getByRole('button',{name:'账户与隐私',exact:true}).click();
  await page.locator('.settings-card').getByRole('button',{name:'账户与隐私',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'账户与隐私',exact:true});
  await dialog.getByLabel('说明',{exact:true}).fill('语音输入能不能支持粤语？');
  await expect(dialog.getByRole('button',{name:'申请删除账户'})).toHaveCount(0);
  await dialog.getByRole('button',{name:'提交',exact:true}).click();
  await expect(dialog.getByRole('status')).toContainText('question-reference');
  expect(sent).toEqual({kind:'privacy',note:'语音输入能不能支持粤语？'});
  await page.screenshot({path:info.outputPath('account-question.png')});
});
test('the public support form initiates deletion without app installation or login',async({page})=>{
  let sent: unknown;await page.route('**/api/support/requests',async r=>{sent=r.request().postDataJSON();await r.fulfill({status:201,json:{id:'external-reference'}});});
  await page.goto('/account-deletion.html');
  await page.getByLabel('联系邮箱').fill('fixture@example.com');
  await page.getByLabel('注册时使用的邮箱或账号').fill('fixture-member');
  await page.getByLabel('说明').fill('Delete my account and data.');
  await page.getByRole('button',{name:'提交请求'}).click();
  await expect(page.getByRole('status')).toContainText('external-reference');
  expect(sent).toEqual({kind:'deletion',email:'fixture@example.com',username:'fixture-member',note:'Delete my account and data.'});
});
test('public pages show one language: ?lang=, then the console choice, then the browser',async({page})=>{
  let locale: string|undefined; await page.route('**/api/support/requests',async r=>{locale=r.request().headers()['x-aio-locale'];await r.fulfill({status:429,json:{error:'rate_limited',message:'Demasiadas solicitudes'}});});
  await page.goto('/account-deletion.html?lang=es');
  await expect(page.locator('html')).toHaveAttribute('lang','es'); await expect(page).toHaveTitle('Soporte y eliminación de la cuenta · Clawpage Agent');
  await expect(page.locator('main > section:visible')).toHaveCount(1); await expect(page.locator('main > section:visible')).toHaveAttribute('lang','es');
  await page.getByLabel('Correo electrónico de contacto').fill('fixture@example.com');
  await page.getByLabel('Explicación').fill('Borrar mi cuenta.');
  await page.getByRole('button',{name:'Enviar solicitud'}).click();
  await expect(page.getByRole('status')).toHaveText('Demasiadas solicitudes'); expect(locale).toBe('es');
  await page.getByRole('link',{name:'Política de privacidad'}).click();
  await expect(page).toHaveURL(/\/privacy\.html\?lang=es$/);
  await page.evaluate(()=>localStorage.setItem('aio.locale','zh-TW'));
  await page.goto('/privacy.html');
  await expect(page.locator('main > section:visible')).toHaveAttribute('lang','zh-TW'); await expect(page).toHaveTitle('隱私權政策 · 一站 Clawpage Agent');
  await page.evaluate(()=>localStorage.removeItem('aio.locale'));
  await page.goto('/terms.html');
  await expect(page.locator('html')).toHaveAttribute('lang','zh-CN'); await expect(page.getByRole('heading',{level:1})).toHaveText('服务条款');
});

test('public pages speak Japanese: ?lang=ja, the console choice and a Japanese browser',async({browser})=>{
  const context=await browser.newContext({locale:'ja-JP'}); const page=await context.newPage();
  let locale: string|undefined; await page.route('**/api/support/requests',async r=>{locale=r.request().headers()['x-aio-locale'];await r.fulfill({json:{id:'req_ja'}});});
  // A Japanese browser opens the Japanese section, with nothing chosen.
  await page.goto('/about.html');
  await expect(page.locator('html')).toHaveAttribute('lang','ja'); await expect(page.locator('main > section:visible')).toHaveCount(1);
  await expect(page.getByRole('heading',{level:1})).toHaveText('AI にまかせるワークスペース');
  await expect(page.locator('.langs a[aria-current]')).toHaveText('日本語');
  await page.goto('/account-deletion.html');
  await expect(page).toHaveTitle('サポートとアカウント削除 · Clawpage Agent');
  await page.getByLabel('連絡先メールアドレス').fill('fixture@example.com');
  await page.getByLabel('説明').fill('アカウントを削除してください。');
  await page.getByRole('button',{name:'申請を送信'}).click();
  await expect(page.getByRole('status')).toHaveText('申請を受け付けました。管理者による本人確認をお待ちください。受付番号を控えておいてください：req_ja'); expect(locale).toBe('ja');
  // ?lang= wins over the browser.
  await page.goto('/privacy.html?lang=en');
  await expect(page.locator('main > section:visible')).toHaveAttribute('lang','en');
  await context.close();
  // On an English browser, the console's choice of Japanese wins, and ?lang=ja carries over to the other pages.
  const english=await browser.newContext({locale:'en-US'}); const other=await english.newPage();
  await other.goto('/terms.html');
  await expect(other.locator('main > section:visible')).toHaveAttribute('lang','en');
  await other.evaluate(()=>localStorage.setItem('aio.locale','ja'));
  await other.reload();
  await expect(other.locator('main > section:visible')).toHaveAttribute('lang','ja'); await expect(other).toHaveTitle('利用規約 · Clawpage Agent');
  await other.evaluate(()=>localStorage.removeItem('aio.locale'));
  await other.goto('/privacy.html?lang=ja');
  await expect(other.getByRole('heading',{level:1})).toHaveText('プライバシーポリシー');
  await other.getByRole('link',{name:'利用規約'}).click();
  await expect(other).toHaveURL(/\/terms\.html\?lang=ja$/);
  await expect(other.getByRole('heading',{level:1})).toHaveText('利用規約');
  await english.close();
});
test('the owner reads the votes on replies under user support',async({page},info)=>{
  await mockConsole(page,{conversations:[]});
  await page.route('**/api/auth/session',r=>r.fulfill({json:{authenticated:true,username:'owner',role:'owner'}}));
  await page.route('**/api/main*',r=>r.fulfill({json:{mode:'tasks',tasks:[],nextBefore:null}}));
  await page.route(url=>url.pathname==='/api/settings/support',r=>r.fulfill({json:{requests:[]}}));
  await page.route('**/api/settings/support/feedback',r=>r.fulfill({json:{feedback:[
    {id:'f1',task_id:'t1',rating:'down',title:'Trip plan',content:'The reply with the wrong dates',note:'Wrong dates.',updated_at:Date.now(),account_username:'cr'},
    {id:'f2',task_id:'t2',rating:'up',title:'Grocery list',content:'',note:'',updated_at:Date.now()-60000,account_username:'yzmy'}]}}));
  await page.goto('/u/owner/settings/support');
  const items=page.locator('.support-settings .support-request');
  await expect(page.getByRole('heading',{name:'回复反馈'})).toBeVisible();
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText('👎 没帮助 · cr'); await expect(items.nth(0)).toContainText('Wrong dates.');
  await items.nth(0).getByText('Trip plan',{exact:true}).last().click();
  await expect(items.nth(0)).toContainText('The reply with the wrong dates');
  await expect(items.nth(1)).toContainText('👍 有帮助 · yzmy');
  await page.screenshot({path:info.outputPath('owner-feedback.png'),fullPage:true});
});
