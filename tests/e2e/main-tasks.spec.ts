import { test, expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { makeConversation, mockConsole } from "./mock-api";
import type { Task } from "../../src/ui/src/types";
import fs from "node:fs";
import { patchNoVncUi } from "../../src/control/sandbox/novncPatch";
function task(n: number, status = "running"): Task {
    return { id: `task-${n}`, revision: 1, title: `任务 ${n}`, text: `请求 ${n}`, conversationId: `child-${n}`, status, result: null, error: null, attachments: [], relatedTaskId: null, dependencies: [], approvals: 0, createdAt: 1000 + n, completedAt: null };
}
async function setup(page: Page, rows: Task[] = [], nextBefore:number|null = null) {
    const conversations = [makeConversation("old", "保留的旧会话"), ...rows.map(t => makeConversation(t.conversationId, t.title))];
    await mockConsole(page, { conversations });
    const bodies: Array<Record<string, any>> = [];
    const stops: string[] = [];
    await page.route("**/api/main*", r => r.fulfill({ json: { mode: "tasks", tasks: rows, nextBefore } }));
    await page.route("**/api/tasks", async (r) => {
        const body = r.request().postDataJSON();
        bodies.push(body);
        const t = { ...task(rows.length + 1), text: body.text, attachments: body.attachments, relatedTaskId: body.relatedTaskId };
        rows.push(t);
        conversations.push(makeConversation(t.conversationId, t.title));
        await r.fulfill({ status: 202, json: { task: t, duplicate: false } });
    });
    await page.route("**/api/tasks/*/stop", async (r) => {
        const id = new URL(r.request().url()).pathname.split("/")[3]!;
        stops.push(id);
        const t = rows.find(t => t.id === id)!;
        Object.assign(t, { status: "interrupted", completedAt: Date.now(), revision: t.revision + 1 });
        await r.fulfill({ json: { ok: true } });
    });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "主会话", exact: true })).toBeVisible();
    return { rows, bodies, stops };
}
/** A real touch tap on touch devices: a mouse click would hide tap-only failures (WebKit drops the click of a prevented press). */
const press = (info: TestInfo, target: Locator, position?: { x: number; y: number }) => (info.project.use.hasTouch ? target.tap({ position }) : target.click({ position }));
const send = async (page: Page, text: string) => { await page.getByRole("textbox", { name: "消息", exact: true }).fill(text); await page.getByRole("button", { name: "发送", exact: true }).click(); await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue(""); };
test("a YouTube or Bilibili link in a result plays in place on a computer, and opens in the browser or app on a phone", async ({ page }, info) => {
    const players: string[] = [];
    for (const host of ["https://www.youtube-nocookie.com/**", "https://player.bilibili.com/**"]) {
        await page.route(host, r => { players.push(r.request().url()); return r.fulfill({ contentType: "text/html", body: "<body style='margin:0;background:#222;color:#fff'>player</body>" }); });
    }
    await page.context().route(/^https:\/\/www\.(youtube|bilibili)\.com\//, r => r.fulfill({ contentType: "text/html", body: "video page" }));
    const result = "找到两个讲解：\n\n- [3Blue1Brown 讲神经网络](https://www.youtube.com/watch?v=aircAruvnKk&t=90)\n- https://www.bilibili.com/video/BV1bx411c7ux/?p=2\n\n代码里的 `https://youtu.be/dQw4w9WgXcQ` 不算。";
    await setup(page, [{ ...task(1, "completed"), result, completedAt: Date.now() }]);
    const videos = page.getByTestId("message-videos");
    if (info.project.name.startsWith("mobile")) {
        // On a phone: no player in the page, a card per video that opens its page in a new tab (the browser, or the app).
        await expect(videos.locator("iframe")).toHaveCount(0);
        const cards = videos.locator("a.video-link");
        await expect(cards).toHaveCount(2);
        await expect(cards.nth(0)).toHaveAttribute("href", "https://www.youtube.com/watch?v=aircAruvnKk&t=90s");
        await expect(cards.nth(0)).toHaveAttribute("target", "_blank");
        await expect(cards.nth(0)).toContainText("3Blue1Brown 讲神经网络");
        await expect(cards.nth(0)).toContainText("在 YouTube 打开");
        await expect(cards.nth(1)).toHaveAttribute("href", "https://www.bilibili.com/video/BV1bx411c7ux/?p=2");
        await expect(cards.nth(1)).toContainText("在 B 站 打开");
        const [tab] = await Promise.all([page.context().waitForEvent("page"), cards.nth(0).click()]);
        await expect.poll(() => tab.url()).toBe("https://www.youtube.com/watch?v=aircAruvnKk&t=90s");
        await tab.close();
        // The link in the text does the same instead of going to the sandbox browser.
        const [tab2] = await Promise.all([page.context().waitForEvent("page"), page.locator(".markdown").getByRole("link", { name: "3Blue1Brown 讲神经网络", exact: true }).click()]);
        await expect.poll(() => tab2.url()).toBe("https://www.youtube.com/watch?v=aircAruvnKk&t=90");
        await tab2.close();
        expect(players).toEqual([]);
    } else {
        const frames = videos.locator("iframe");
        await expect(frames).toHaveCount(2);
        await expect(frames.nth(0)).toHaveAttribute("src", "https://www.youtube-nocookie.com/embed/aircAruvnKk?rel=0&playsinline=1&start=90");
        await expect(frames.nth(0)).toHaveAttribute("title", "YouTube 视频：3Blue1Brown 讲神经网络");
        await expect(frames.nth(1)).toHaveAttribute("src", "https://player.bilibili.com/player.html?bvid=BV1bx411c7ux&page=2&autoplay=0&high_quality=1");
        await expect(frames.nth(0)).toHaveAttribute("sandbox", "allow-scripts allow-same-origin allow-presentation");
        // The players load, at 16:9, inside the message.
        await expect.poll(() => players.length).toBeGreaterThanOrEqual(1);
        const box = (await frames.nth(0).boundingBox())!;
        expect(Math.abs(box.width / box.height - 16 / 9)).toBeLessThan(0.02);
        // The link itself opens the page in the device browser.
        await expect(page.getByRole("link", { name: "3Blue1Brown 讲神经网络" })).toHaveAttribute("href", "https://www.youtube.com/watch?v=aircAruvnKk&t=90");
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await videos.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("main-videos.png") });
});
test("MP4 attachments and results preview directly in the main inbox",async({page},info)=>{
    const path='/home/gem/workspace/uploads/demo.mp4';
    const row={...task(1,'completed'),attachments:[{name:'demo.mp4',path,kind:'file' as const,size:3641}],result:`结果见 [视频结果](${path})。`,completedAt:Date.now()};
    await page.route('**/api/documents/media**',r=>r.fulfill({contentType:'video/mp4',body:fs.readFileSync(new URL('../fixtures/preview.mp4',import.meta.url))}));
    await setup(page,[row]);
    for(const label of ['预览 demo.mp4','预览 视频结果']){
      await page.getByRole('button',{name:label,exact:true}).click();
      const video=page.getByTestId('file-preview-video');
      await expect.poll(()=>video.evaluate(n=>(n as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(1);
      await expect(page.getByTestId('file-preview-download')).toHaveAttribute('href',`/api/files/download?path=${encodeURIComponent(path)}`);
      await page.screenshot({path:info.outputPath('main-mp4.png')});
      await page.getByRole('button',{name:'关闭预览'}).click();
    }
});
test('task list shares live statuses, opens each task, preserves draft and returns to the list',async({page},info)=>{
    const pending={...task(1,'needs_input'),clarification:'请补充出行日期'};
    const {rows}=await setup(page,[pending,task(2),{...task(3,'completed'),result:'Done',completedAt:Date.now()},{...task(4,'merged'),mergedInto:'task-2'}]);
    await page.getByRole('textbox',{name:'消息',exact:true}).fill('保留草稿');
    const openList=async()=>{if(info.project.name.startsWith('mobile'))await page.getByRole('button',{name:'打开导航'}).click();await page.locator('.sidebar').getByRole('button',{name:'任务列表',exact:true}).click();};
    const mainHeader=await page.locator('.task-chat .chat-head').boundingBox();
    await openList();await expect(page.getByRole('heading',{name:'任务列表',exact:true})).toBeVisible();
    if(info.project.name.startsWith('mobile')) {
      for(const width of [390,360]) {
        await page.setViewportSize({width,height:844});
        const header=await page.locator('.task-list-page > .chat-head').boundingBox();
        const menu=await page.getByRole('button',{name:'打开导航'}).boundingBox();
        const title=await page.locator('.task-list-page h2').boundingBox();
        const first=await page.locator('.task-list-item').first().boundingBox();
        expect(header!.height).toBe(mainHeader!.height);
        expect(menu!.y).toBeGreaterThanOrEqual(header!.y);
        expect(menu!.y+menu!.height).toBeLessThanOrEqual(header!.y+header!.height);
        expect(title!.x).toBeGreaterThanOrEqual(menu!.x+menu!.width);
        expect(first!.y).toBeGreaterThanOrEqual(header!.y+header!.height);
      }
    }
    await expect(page.locator('.task-list-item')).toHaveCount(3);
    const row=page.locator('.task-list [data-task-id="task-2"]');await expect(row).toContainText('进行中');
    Object.assign(rows[1]!,{status:'completed',result:'Updated',completedAt:Date.now()+1,revision:2});await expect(row).toContainText('已完成');
    await page.getByRole('button',{name:'打开任务：任务 2',exact:true}).click();await expect(page.locator('.task-detail')).toBeVisible();
    await expect(page.locator('.task-detail h2')).toHaveText('任务 2');await page.getByRole('button',{name:'← 返回任务列表'}).click();await expect(row).toBeVisible();
    Object.assign(rows[0]!,{status:'failed',clarification:null,error:'Failed',revision:2});await expect(page.locator('.task-list [data-task-id="task-1"]')).toContainText('执行失败');
    if(info.project.name.startsWith('mobile'))await page.setViewportSize({width:360,height:844});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);await page.screenshot({path:info.outputPath('task-list.png')});
    if(info.project.name.startsWith('mobile'))await page.getByRole('button',{name:'打开导航'}).click();await page.locator('.sidebar').getByRole('button',{name:'主会话',exact:true}).click();
    await expect(page.getByRole('textbox',{name:'消息',exact:true})).toHaveValue('保留草稿');
});
test('task list can load older pages and keeps them after live refresh',async({page},info)=>{
    // A main session taller than the screen: it would load older tasks by itself only near its top.
    const recent={...task(1,'completed'),result:'很长的结果。'.repeat(400),completedAt:2000};
    await setup(page,[recent],1000);
    await page.route('**/api/main*',r=>r.fulfill({json:new URL(r.request().url()).searchParams.has('before')?{mode:'tasks',tasks:[{...task(99,'completed'),result:'Old result',completedAt:999}],nextBefore:null}:{mode:'tasks',tasks:[recent],nextBefore:1000}}));
    if(info.project.name.startsWith('mobile'))await page.getByRole('button',{name:'打开导航'}).click();await page.locator('.sidebar').getByRole('button',{name:'任务列表',exact:true}).click();
    await page.getByRole('button',{name:'加载更早的任务',exact:true}).click();await expect(page.getByRole('button',{name:'打开任务：任务 99',exact:true})).toBeVisible();
    await expect(page.locator('.task-list-item')).toHaveCount(2);await expect(page.locator('.task-list-page').getByRole('button',{name:'加载更早的任务',exact:true})).toHaveCount(0);
});
test('task list groups by turn, running and date, and filters by status and text',async({page},info)=>{
    const day=86_400_000,noon=new Date();noon.setHours(12,0,0,0);
    const done=(n:number,at:number,extra:Partial<Task>={})=>({...task(n,'completed'),result:'Done',createdAt:at-60_000,completedAt:at,...extra});
    await setup(page,[
      {...task(1,'needs_input'),clarification:'请补充出行日期',createdAt:noon.getTime()-3*day},
      {...task(2),createdAt:noon.getTime()-day},
      done(3,noon.getTime(),{title:'订东京机票'}),
      {...done(4,noon.getTime()-day),status:'failed',error:'Failed'},
      done(5,noon.getTime()-40*day,{schedule:{id:'s1',title:'每日账单检查',rule:'每天 9:00'}}),
    ]);
    if(info.project.name.startsWith('mobile'))await page.getByRole('button',{name:'打开导航'}).click();await page.locator('.sidebar').getByRole('button',{name:'任务列表',exact:true}).click();
    const list=page.locator('.task-list-page'),heads=list.locator('.task-group-head');
    await expect(heads).toHaveCount(5);
    expect(await list.locator('.task-group').evaluateAll(els=>els.map(e=>e.getAttribute('aria-label')))).toEqual(['轮到你','进行中','今天','昨天',expect.stringMatching(/月$/)]);
    await expect(list.locator('.task-group[data-group="attention"] [data-task-id="task-1"]')).toBeVisible();
    await expect(list.locator('[data-task-id="task-5"] .task-tag')).toHaveText('定时');
    const filter=(name:string)=>page.getByRole('group',{name:'按状态筛选'}).getByRole('button',{name:new RegExp(`^${name}`)});
    await expect(filter('轮到你')).toContainText('1');
    await filter('已完成').click();await expect(filter('已完成')).toHaveAttribute('aria-pressed','true');
    await expect(list.locator('.task-list-item')).toHaveCount(2);await expect(heads.first()).toHaveText(/今天/);
    await filter('失败·停止').click();await expect(list.locator('.task-list-item')).toHaveCount(1);await expect(list.locator('[data-task-id="task-4"]')).toBeVisible();
    await filter('全部').click();
    await page.getByRole('searchbox',{name:'搜索任务'}).fill('账单');await expect(list.locator('.task-list-item')).toHaveCount(1);await expect(list.locator('[data-task-id="task-5"]')).toBeVisible();
    await page.getByRole('searchbox',{name:'搜索任务'}).fill('不存在的任务');await expect(page.getByRole('heading',{name:'没有符合条件的任务'})).toBeVisible();
    if(info.project.name.startsWith('mobile'))await page.setViewportSize({width:360,height:844});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
    await page.getByRole('button',{name:'清除筛选'}).click();await expect(list.locator('.task-list-item')).toHaveCount(5);
    await expect(page.getByRole('searchbox',{name:'搜索任务'})).toHaveValue('');
    await page.screenshot({path:info.outputPath('task-list-groups.png')});
});
test("one inbox accepts parallel messages, folds progress, reports completion order and survives reload", async ({ page }, info) => {
    const { rows, bodies } = await setup(page);
    await expect(page.locator(".chat-head").getByRole("button", { name: "工作区", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /新建会话/ })).toHaveCount(0);
    await send(page, "写报告");
    await send(page, "另外计算数字");
    await send(page, "再做图片");
    expect(bodies).toHaveLength(3);
    await expect(page.locator(".task-progress")).toHaveCount(3);
    await expect(page.locator(".task-report")).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "消息", exact: true })).toBeEnabled();
    Object.assign(rows[1]!, { status: "completed", result: "数字结果 B", completedAt: 2000, revision: 2 });
    Object.assign(rows[0]!, { status: "completed", result: "报告结果 A", completedAt: 3000, revision: 2 });
    await expect(page.locator(".task-report .bubble")).toHaveText(["数字结果 B", "报告结果 A"]);
    await page.reload();
    await expect(page.locator(".task-report")).toHaveCount(2);
    await expect(page.locator(".task-progress")).toHaveCount(1);
    const heading = await page.locator(".task-report-heading").first().boundingBox();
    const bubble = await page.locator(".task-report .bubble").first().boundingBox();
    expect(bubble!.y).toBeGreaterThanOrEqual(heading!.y + heading!.height);
    const short = await page.locator(".task-entry .msg.user p").first().boundingBox();
    expect(short!.height).toBeLessThan(40);
    await page.screenshot({ path: `/Users/mengxiao/workspace/.scratch/artifacts/aio-main-tasks/${info.project.name}-main.png`, animations: "disabled" });
});
test("per-task stop and natural followup never stop other tasks", async ({ page }) => {
    const { rows, bodies, stops } = await setup(page, [task(1), task(2)]);
    await page.locator('.task-entry[data-task-id="task-1"]').getByRole("button", { name: "停止该任务" }).click();
    await expect(page.locator(".task-progress")).toHaveCount(1);
    expect(stops).toEqual(["task-1"]);
    expect(rows[1]!.status).toBe("running");
    await expect(page.getByRole("button", { name: "补充此任务" })).toHaveCount(0);
    await send(page, "接着做第二部分");
    expect(bodies[0]?.relatedTaskId).toBeNull();
});
test("attachments and drafts survive config and task details without a history entry", async ({ page }, info) => {
    await setup(page, [task(1)]);
    await page.route("**/api/sandbox/upload", r => r.fulfill({ json: { path: "/home/gem/workspace/uploads/a.txt", name: "a.txt", kind: "file" } }));
    const chooser = page.waitForEvent("filechooser");
    await page.locator(".file-button").click();
    await (await chooser).setFiles({ name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
    await expect(page.locator(".composer .chips")).toContainText("a.txt");
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("保留草稿");
    if (info.project.name.startsWith("mobile")) await page.getByRole("button", { name: "打开导航" }).click();
    const nav = page.locator(".sidebar");
    await nav.getByRole("button", { name: "配置", exact: true }).click();
    await expect(page.getByRole("heading", { name: "配置", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "← 返回会话" }).click();
    await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("保留草稿");
    await expect(page.locator(".composer .chips")).toContainText("a.txt");
    await expect(page.getByRole("button", { name: /^历史(记录)?$/ })).toHaveCount(0);
    await expect(page.locator(".bottom-nav")).toHaveCount(0);
    await page.getByRole("button", { name: "展开任务：任务 1" }).click();
    await expect(page.locator(".task-detail")).toBeVisible();
    await expect(page.locator(".task-detail .chat-head").getByRole("button", { name: "工作区", exact: true })).toHaveCount(0);
    await expect(page.locator(".task-detail .composer")).toHaveCount(0);
    await page.getByRole("button", { name: "← 返回主会话" }).click();
    await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("保留草稿");
});
test("failed submit preserves payload and idempotency key, details stay folded and fit mobile", async ({ page }, info) => {
    const pending = task(1);
    pending.approvals = 1;
    await setup(page, [pending]);
    await expect(page.locator(".task-summary")).toContainText("需要你确认");
    const keys: string[] = [];
    let fail = true;
    await page.route("**/api/tasks", async (r) => { keys.push(r.request().postDataJSON().clientMessageId); if (fail) {
        fail = false;
        await r.fulfill({ status: 503, json: { message: "暂时失败" } });
    }
    else
        await r.fallback(); });
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("重试消息");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("内容已保留");
    await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("重试消息");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.locator(".task-entry")).toHaveCount(2);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    for (const width of info.project.name.startsWith("mobile") ? [390, 360] : [1440]) {
        await page.setViewportSize({ width, height: 844 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
        const box = await page.locator(".composer").boundingBox();
        expect(box!.height).toBeLessThan(220);
        expect(box!.y + box!.height).toBeLessThanOrEqual(844);
        expect(await page.locator(".task-progress.active .task-progress-label").first().evaluate(el => getComputedStyle(el).animationName)).toBe("none");
    }
    await page.getByRole("button", { name: "展开任务：任务 1" }).click();
    await expect(page.locator(".task-detail")).toBeVisible();
    await expect(page.locator(".task-detail .chat-head").getByRole("button", { name: "工作区", exact: true })).toHaveCount(0);
    const box = await page.locator(".task-detail .chat-scroll").boundingBox();
    expect(box!.height).toBeGreaterThan(400);
});

test("related supplement joins the original task, with one running indicator and one final report",async({page},info)=>{
    const parent=task(1);parent.title="带娃三天行程";
    const {rows}=await setup(page,[parent]);
    await send(page,"我民宿住在902 links way，帮我也找好餐厅推荐");
    Object.assign(rows[1]!,{mergedInto:parent.id,mergedTitle:parent.title,conversationId:parent.conversationId,status:"merged",revision:2});
    await expect(page.locator(".task-supplement")).toContainText("已补充到：带娃三天行程");
    await expect(page.locator('.task-entry[data-task-id="task-1"] .task-progress')).toHaveCount(0);
    await expect(page.locator('.task-entry[data-task-id="task-2"] .task-progress')).toContainText(parent.title);
    await expect(page.locator(".task-progress")).toHaveCount(1);
    await expect(page.locator(".chat-sub .turn-pill")).toHaveText(["1 件在办"]);
    await page.locator(".task-supplement button").click();
    await expect(page.locator(".task-detail")).toBeVisible();
    await expect(page.locator(".task-detail .chat-head").getByRole("button", { name: "工作区", exact: true })).toHaveCount(0);
    await page.getByRole("button",{name:"← 返回主会话"}).click();
    await page.reload();
    await expect(page.locator(".task-progress")).toHaveCount(1);
    await expect(page.locator('.task-entry[data-task-id="task-2"] .task-progress')).toContainText(parent.title);
    await send(page,"另外帮我写邮件");
    await send(page,"行程里再加一个休息点");
    Object.assign(rows[3]!,{mergedInto:parent.id,mergedTitle:parent.title,conversationId:parent.conversationId,status:"merged",revision:2});
    await expect(page.locator('.task-entry[data-task-id="task-2"] .task-progress')).toHaveCount(0);
    await expect(page.locator('.task-entry[data-task-id="task-4"] .task-progress')).toContainText(parent.title);
    await expect(page.locator('.task-entry[data-task-id="task-3"] .task-progress')).toHaveCount(1);
    await page.locator('.task-entry[data-task-id="task-4"]').getByRole('button',{name:`引用任务：${parent.title}`}).click();
    await expect(page.locator('.task-reference')).toContainText(parent.title);
    Object.assign(rows[0]!,{status:"completed",result:"包含民宿附近餐厅推荐的完整行程",revision:3,completedAt:Date.now()});
    await expect(page.locator(".task-report")).toHaveCount(1);
    await expect(page.locator(".task-progress")).toHaveCount(1);
    await expect(page.locator('.task-entry[data-task-id="task-3"] .task-progress')).toHaveCount(1);
    await expect(page.locator(".task-report .bubble")).toContainText("餐厅推荐");
    for(const width of info.project.name.startsWith("mobile")?[390,360]:[1440]){
        await page.setViewportSize({width,height:844});
        expect(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    }
    await page.screenshot({path:`/Users/mengxiao/workspace/.scratch/artifacts/aio-remove-history/${info.project.name}-supplement.png`,animations:"disabled"});
});

test("shows one stable overview only when execution starts, retaining it through polls and reload",async({page},info)=>{
    const description="我会结合十点退房安排返程路线，选择途中适合休息和用餐的地点，给你一份完整行程。";
    const pending={...task(1,"waiting"),description};
    const {rows}=await setup(page,[pending]);
    await expect(page.locator(".task-intro")).toHaveCount(0);
    Object.assign(rows[0]!,{status:"running",revision:2});
    await expect(page.locator(".task-intro")).toHaveText(description);
    Object.assign(rows[0]!,{revision:3,approvals:1});
    await expect(page.locator(".task-summary")).toContainText("需要你确认");
    await expect(page.locator(".task-intro")).toHaveCount(1);
    await page.reload();
    await expect(page.locator(".task-intro")).toHaveText(description);
    if(info.project.name.startsWith("mobile"))await page.setViewportSize({width:360,height:844});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({path:`/Users/mengxiao/workspace/.scratch/artifacts/aio-task-intro/${info.project.name}.png`,animations:"disabled"});
    Object.assign(rows[0]!,{status:"completed",result:"返程安排已完成",revision:4,completedAt:Date.now()});
    await expect(page.locator(".task-intro")).toHaveCount(0);
    await expect(page.locator(".task-report")).toHaveCount(1);
});

test("clarification stays inline, answers target the right task and unrelated work stays available",async({page},info)=>{
    const first=task(1,"needs_input"),second=task(2,"needs_input"),working=task(3);
    first.clarification="想从哪里出发、去哪里，哪天出行？";
    second.clarification="这份演示要介绍哪个产品？";
    const {bodies,rows}=await setup(page,[first,second,working]);
    await expect(page.locator(".chat-sub .turn-pill")).toHaveText(["2 件等你补充", "1 件在办"]);
    await expect(page.locator(".task-question")).toHaveCount(2);
    await page.reload();
    const question=page.locator('.task-entry[data-task-id="task-2"] .task-question');
    await expect(question).toContainText(second.clarification);
    await expect(question).toHaveAttribute('role','status');await expect(question).toContainText('需要你补充');await expect(question).toContainText('直接在下方输入回复即可');
    await expect(page.getByRole("button",{name:/回答问题|补充此任务|继续此任务|补充任务/})).toHaveCount(0);
    await expect(page.locator(".composer .chip")).toHaveCount(0);
    await send(page,"演示虚构的待办产品");
    expect(bodies[0]?.relatedTaskId).toBeNull();
    await send(page,"另外写个笑话");
    expect(bodies[1]?.relatedTaskId).toBeNull();
    for(const width of info.project.name.startsWith("mobile")?[390,360]:[1440]) {
        await page.setViewportSize({width,height:844});
        expect(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    }
    Object.assign(rows[1]!,{status:"running",clarification:null,revision:2});
    await expect(page.locator(".task-question")).toHaveCount(1);
    await page.locator('.task-entry[data-task-id="task-1"] .task-question').scrollIntoViewIfNeeded();
    await page.screenshot({path:`/Users/mengxiao/workspace/.scratch/artifacts/aio-task-clarification/${info.project.name}.png`});
});

test("mobile drawer replaces bottom navigation and preserves the chat draft",async({page},info)=>{
    await setup(page,[task(1)]);
    await expect(page.locator('.bottom-nav')).toHaveCount(0);
    if(!info.project.name.startsWith('mobile')) {
        await expect(page.locator('.sidebar')).toBeVisible();
        await expect(page.getByRole('button',{name:'打开导航'})).toBeHidden();
        return;
    }
    for(const width of [390,360]) {
        await page.setViewportSize({width,height:844});
        const menu=page.getByRole('button',{name:'打开导航'});
        await expect(menu).toBeVisible();
        await expect(page.locator('.sidebar')).toBeHidden();
        await page.getByRole('textbox',{name:'消息',exact:true}).fill('保留这段草稿');
        const composer=await page.locator('.composer').boundingBox();
        expect(composer!.y+composer!.height).toBeGreaterThan(830);
        await menu.click();
        const drawer=page.getByRole('dialog',{name:'导航'});
        await expect(drawer).toBeVisible();
        await expect(menu).toHaveAttribute('aria-expanded','true');
        await expect(page.getByRole('button',{name:'关闭导航'})).toBeFocused();
        // The close mark sits in the middle of its button, like the menu mark.
        const closeBox=await page.getByRole('button',{name:'关闭导航'}).boundingBox();
        const markBox=await page.getByRole('button',{name:'关闭导航'}).locator('svg').boundingBox();
        expect(Math.abs((markBox!.x+markBox!.width/2)-(closeBox!.x+closeBox!.width/2))).toBeLessThan(1);
        expect(Math.abs((markBox!.y+markBox!.height/2)-(closeBox!.y+closeBox!.height/2))).toBeLessThan(1);
        await page.keyboard.press('Shift+Tab');
        await expect(drawer.getByRole('button',{name:'退出登录'})).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(drawer).toHaveCount(0);await expect(menu).toBeFocused();
        await menu.click();
        await page.locator('.mobile-menu-backdrop').click({position:{x:width-5,y:400}});
        await expect(page.locator('.sidebar')).toBeHidden();
        await menu.click();await drawer.getByRole('button',{name:'配置',exact:true}).click();
        await expect(page.getByRole('heading',{name:'配置',exact:true})).toBeVisible();
        await expect(page.locator('.sidebar')).toBeHidden();
        await menu.click();await drawer.getByRole('button',{name:'主会话',exact:true}).click();
        await expect(page.getByRole('textbox',{name:'消息',exact:true})).toHaveValue('保留这段草稿');
        await menu.click();await drawer.getByRole('button',{name:'工作区',exact:true}).click();
        await expect(page.locator('.workspace')).toBeVisible();
        const workspace=await page.locator('.workspace').boundingBox();expect(workspace!.y+workspace!.height).toBe(844);
        await menu.click();await drawer.getByRole('button',{name:'主会话',exact:true}).click();
        await expect(page.locator('.workspace')).toHaveCount(0);
        expect(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    }
    await page.getByRole('button',{name:'打开导航'}).click();
    await page.screenshot({path:`/Users/mengxiao/workspace/.scratch/artifacts/aio-mobile-drawer/${info.project.name}-drawer.png`});
    await page.getByRole('button',{name:'关闭导航'}).click();
    await page.screenshot({path:`/Users/mengxiao/workspace/.scratch/artifacts/aio-mobile-drawer/${info.project.name}-chat.png`});
});

test("message times and task elapsed durations update and freeze without including the queue", async ({ page }, info) => {
    const now = new Date(2026, 8, 27, 14, 30).getTime();
    await page.clock.install({ time: now });
    const running = { ...task(1), createdAt: now - 300_000, startedAt: now - 65_000 };
    const waiting = { ...task(2, "waiting"), createdAt: now - 200_000, startedAt: null };
    const done = { ...task(3, "completed"), createdAt: now - 180_000, startedAt: now - 150_000, completedAt: now - 60_000, result: "这是整理好的结果。" };
    const { rows } = await setup(page, [running, waiting, done]);
    const entry = page.locator('.task-entry[data-task-id="task-1"]');
    await expect(entry.locator("time")).toHaveText("5 分钟前");
    await expect(entry.locator("time")).toHaveAttribute("datetime", new Date(running.createdAt).toISOString());
    await expect(entry.locator("time")).toHaveAttribute("title", /2026/);
    await expect(entry.locator(".task-duration")).toHaveText("已处理 1 分 5 秒");
    await expect(page.locator('.task-entry[data-task-id="task-2"] .task-duration')).toHaveCount(0);
    const report = page.locator('.task-report[data-task-id="task-3"]');
    await expect(report.locator("time")).toHaveText("1 分钟前");
    await expect(report.locator(".task-duration")).toHaveText("处理用时 1 分 30 秒");
    await page.clock.fastForward(5000);
    await expect(entry.locator(".task-duration")).toHaveText("已处理 1 分 10 秒");
    Object.assign(rows[0]!, { status: "completed", result: "完成", completedAt: now + 5000, revision: 2 });
    await page.clock.fastForward(3000);
    await expect(page.locator('.task-report[data-task-id="task-1"] .task-duration')).toHaveText("处理用时 1 分 10 秒");
    await page.clock.fastForward(60000);
    await expect(page.locator('.task-report[data-task-id="task-1"] .task-duration')).toHaveText("处理用时 1 分 10 秒");
    await page.reload();
    await expect(report.locator(".task-duration")).toHaveText("处理用时 1 分 30 秒");
    if (info.project.name.startsWith("mobile")) await page.setViewportSize({ width: 360, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `/Users/mengxiao/workspace/.scratch/artifacts/aio-message-times/${info.project.name}.png` });
});

test("waiting identifies its blocker and updates without a revision bump",async({page},info)=>{
 const pending=task(1,"waiting");pending.waitReason={label:"等待文件操作",message:"“整理项目”正在使用同一文件范围或共享环境，结束后自动继续。"};
 const {rows}=await setup(page,[pending]);
 await expect(page.locator('.task-progress-label')).toHaveText("等待文件操作");
 await expect(page.locator('.task-wait-reason')).toContainText("整理项目");
 const box=await page.locator('.task-wait-reason').boundingBox();expect(box!.x+box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
 await page.screenshot({path:`/Users/mengxiao/workspace/.scratch/artifacts/aio-scoped-resources/wait-${info.project.name}.png`,animations:"disabled"});
 rows[0]!.waitReason={label:"等待执行空位",message:"已有 3 个任务执行中，空位释放后自动开始。"};
 await expect(page.locator('.task-progress-label')).toHaveText("等待执行空位");
 Object.assign(rows[0]!,{status:"running",revision:2,waitReason:null});
 await expect(page.locator('.task-progress-label')).toHaveText("在办");await expect(page.locator('.task-wait-reason')).toHaveCount(0);
});

test("manual task reference persists with the draft, is cancellable, and binds the submitted target",async({page},info)=>{
 const finished={...task(2,"completed"),result:"原任务结果",completedAt:2000};
 const {bodies}=await setup(page,[task(1),finished]);
 const input=page.getByRole('textbox',{name:'消息',exact:true});await input.fill('保留我的补充');
 await page.getByRole('button',{name:'引用任务：任务 1',exact:true}).click();
 await expect(page.locator('.task-reference')).toContainText('任务 1');await expect(input).toBeFocused();await expect(input).toHaveValue('保留我的补充');
 if(info.project.name.startsWith('mobile')) await page.getByRole('button',{name:'打开导航'}).click();
 await page.locator('.sidebar').getByRole('button',{name:'配置',exact:true}).click();
 await page.getByRole('button',{name:'← 返回会话'}).click();await expect(page.locator('.task-reference')).toContainText('任务 1');
 await page.getByRole('button',{name:'引用任务：任务 2',exact:true}).click();await expect(page.locator('.task-reference')).toContainText('任务 2');
 await page.screenshot({path:info.outputPath('task-reference.png'),animations:'disabled'});
 const widths=info.project.name.startsWith('mobile')?[390,360]:[1440];
 for(const width of widths){await page.setViewportSize({width,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)).toBeLessThanOrEqual(1);}
 await page.getByRole('button',{name:'发送',exact:true}).click();await expect(page.locator('.task-reference')).toHaveCount(0);
 expect(bodies[0]?.relatedTaskId).toBe('task-2');await expect(page.locator('.msg.user small')).toContainText('任务 2');
 await page.getByRole('button',{name:'引用任务：任务 1',exact:true}).click();await page.getByRole('button',{name:'取消引用任务'}).click();await send(page,'无引用的新任务');expect(bodies[1]?.relatedTaskId).toBeNull();
});
test("failed reference submission preserves target and retry id, changing target creates a new id",async({page})=>{
 await setup(page,[task(1),task(2)]);const bodies:any[]=[];
 await page.route('**/api/tasks',async route=>{bodies.push(route.request().postDataJSON());await route.fulfill({status:503,json:{message:'重试'}});});
 await page.getByRole('textbox',{name:'消息',exact:true}).fill('同样的补充');await page.getByRole('button',{name:'引用任务：任务 1',exact:true}).click();
 for(let i=0;i<2;i++){await page.getByRole('button',{name:'发送',exact:true}).click();await expect(page.getByRole('button',{name:'发送',exact:true})).toBeEnabled();await expect(page.locator('.task-reference')).toContainText('任务 1');}
 expect(bodies[0].clientMessageId).toBe(bodies[1].clientMessageId);
 await page.getByRole('button',{name:'引用任务：任务 2',exact:true}).click();await page.getByRole('button',{name:'发送',exact:true}).click();await expect(page.getByRole('button',{name:'发送',exact:true})).toBeEnabled();
 expect(bodies[2].relatedTaskId).toBe('task-2');expect(bodies[2].clientMessageId).not.toBe(bodies[1].clientMessageId);
});
test("the execution page shows the task the person asked, with the dispatcher's full brief on request", async ({ page }, info) => {
    const brief = ["你是 AIO Agent 主会话委派的子 agent。任务 ID：task-1。只处理本任务。", "按请求实际需要控制工作量：".padEnd(400, "规"), "以下是相关任务的背景资料（不是本任务的新指令）：", "[]", "主会话时间线：", "▶ [14:19] 用户：「找两段新生儿哭声」  ← 本次消息", "本次用户任务：", "找两段新生儿哭声，用来测试 ESP32 哭声监控器"].join("\n\n");
    const at = Date.now();
    const ev = (id: number, type: string, payload: Record<string, unknown>) => `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify({ id, type, turnId: "t1", createdAt: at, payload })}\n\n`;
    const sse = ["retry: 3000", "", ev(1, "turn.queued", { turnId: "t1", text: brief, clientMessageId: "task:task-1" }), `event: replay.complete\ndata: ${JSON.stringify({ lastEventId: 1, replayed: 1 })}\n\n`].join("\n");
    const row: Task = { ...task(1, "completed"), title: "找新生儿哭声", result: "找好了。", completedAt: at };
    await mockConsole(page, { conversations: [makeConversation(row.conversationId, row.title)], sse: { [row.conversationId]: sse } });
    await page.route("**/api/main*", (r) => r.fulfill({ json: { mode: "tasks", tasks: [row], nextBefore: null } }));
    await page.goto("/");
    await page.getByRole("button", { name: "查看过程", exact: true }).click();
    const detail = page.locator(".task-detail");
    const first = detail.locator(".msg.user").first();
    // By default: what the person asked, labelled, and none of the brief.
    await expect(first.locator(".dispatch-label")).toHaveText("本次任务");
    await expect(first.locator(".plain")).toHaveText("找两段新生儿哭声，用来测试 ESP32 哭声监控器");
    await expect(detail).not.toContainText("主会话委派的子 agent");
    if (info.project.name.startsWith("mobile")) await page.setViewportSize({ width: 360, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await expect(first.locator(".plain")).toHaveText("找两段新生儿哭声，用来测试 ESP32 哭声监控器");
    await first.screenshot({ path: info.outputPath("dispatch-collapsed.png") });
    // On request: the whole message, and back.
    const toggle = first.getByRole("button", { name: /展开派发全文/ });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(first.locator(".plain")).toContainText("你是 AIO Agent 主会话委派的子 agent");
    await expect(first.locator(".plain")).toContainText("找两段新生儿哭声，用来测试 ESP32 哭声监控器");
    await first.getByRole("button", { name: "收起，只看本次任务" }).click();
    await expect(first.locator(".plain")).toHaveText("找两段新生儿哭声，用来测试 ESP32 哭声监控器");
});
test("audio and video in a report play where the report puts them, with cards only for what it mentions in passing", async ({ page }, info) => {
    const W = "/home/gem/workspace/tasks/task-1";
    const result = [
        "给你找了两段新生儿哭声：",
        "",
        "🎧 **短版 · 23 秒**：新生儿持续大哭，用来测试或做提示音比较合适。",
        `[新生儿啼哭（23秒）](${W}/新生儿啼哭_23秒.wav)`,
        "",
        "🎧 **长版 · 54 秒**：哭声断断续续，更接近真实场景。",
        `[新生儿啼哭（54秒）](${W}/新生儿啼哭_54秒.wav)`,
        "",
        `录屏演示：`,
        `[监控器演示](${W}/demo.mp4)`,
        "",
        `原始素材也打包在 [素材说明](${W}/README.md) 里。`,
    ].join("\n");
    const row: Task = { ...task(1, "completed"), title: "找新生儿哭声音频", result, completedAt: 2000 };
    await page.route("**/api/documents/media**", (r) => r.fulfill({ status: 404, body: "" }));
    await setup(page, [row]);
    const report = page.locator(`article.task-report[data-task-id="task-1"]`);
    const media = report.locator("figure.media-card");
    await expect(media).toHaveCount(3);
    await expect(media.nth(0)).toHaveAttribute("data-kind", "audio");
    await expect(media.nth(0).locator("figcaption")).toHaveText(/新生儿啼哭（23秒）/);
    await expect(media.nth(2)).toHaveAttribute("data-kind", "video");
    // In the order the report wrote them: the first clip right after its description.
    const order = await report.locator(".markdown").evaluate((el) => [...el.querySelectorAll("p, figure")].map((n) => n.tagName === "FIGURE" ? `[${n.querySelector("figcaption")!.textContent}]` : n.textContent!.slice(0, 8)));
    expect(order.indexOf("[♪新生儿啼哭（23秒）]")).toBe(order.findIndex((t) => t.includes("短版")) + 1);
    // No bare links to them and no duplicate cards: only the file mentioned in a sentence gets a card.
    await expect(report.locator(".markdown a:not(figcaption a)", { hasText: "新生儿啼哭" })).toHaveCount(0);
    await expect(report.getByTestId("file-card")).toHaveCount(1);
    await expect(report.getByTestId("file-card")).toHaveAttribute("data-kind", "markdown");
    // The clips 404 here: each card says so in words instead of a broken player.
    await expect(media.nth(0)).toContainText("暂时放不了");
    // The title opens the preview.
    await media.nth(0).locator("figcaption a").click();
    // (The clip itself 404s here, so the preview may show its error: either way it is this file's preview.)
    await expect(page.getByTestId("file-preview-download")).toBeVisible();
    await page.getByRole("button", { name: "关闭预览" }).click();
    if (info.project.name.startsWith("mobile")) await page.setViewportSize({ width: 360, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await report.screenshot({ path: info.outputPath("media-report.png") });
});
test("a task that needs you in the browser shows why, hands you its own tab to operate and takes it back", async ({ page }, info) => {
    const row: Task = { ...task(1), title: "订餐厅", browser: { tabs: 1, request: "请登录 OpenTable 账号", human: false } };
    const tab = { id: "t1", title: "OpenTable 登录", url: "https://www.opentable.com/signin", lastUsed: 1, finishedAt: null, holder: "ai" as "ai" | "human", request: { reason: "请登录 OpenTable 账号", at: 1 } as { reason: string; at: number } | null };
    const controls: string[] = [];
    await page.route("**/api/tasks/task-1/browser", r => r.fulfill({ json: { tabs: [tab] } }));
    await page.route("**/api/tasks/task-1/browser/screenshot*", r => r.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64") }));
    await page.route("**/api/tasks/task-1/browser/control", async r => {
        const { action } = r.request().postDataJSON();
        controls.push(action);
        Object.assign(tab, action === "take" ? { holder: "human" } : { holder: "ai", request: null });
        row.browser = { tabs: 1, request: tab.request?.reason ?? null, human: tab.holder === "human" };
        await r.fulfill({ json: { tab } });
    });
    const acts: Array<Record<string, unknown>> = [];
    await page.route("**/api/tasks/task-1/browser/pointer", async r => { acts.push(r.request().postDataJSON()); await r.fulfill({ json: { title: tab.title, url: tab.url } }); });
    await setup(page, [row]);
    const tickets: string[] = [];
    await page.route("**/api/workspace/ticket", async r => { tickets.push(r.request().postDataJSON().next); await r.fulfill({ json: { ticket: "t", origin: "http://127.0.0.1:4289", url: "http://127.0.0.1:4289/vnc/vnc.html?ticket=t", expiresAt: Date.now() + 60_000 } }); });
    const card = page.getByRole("group", { name: "任务浏览器：需要你操作" });
    await expect(card).toContainText("请登录 OpenTable 账号");
    await expect(card.getByRole("img", { name: /页面预览/ })).toBeVisible();
    await expect(page.locator(".chat-sub .turn-pill.you")).toHaveText("1 件等你操作浏览器");
    await expect(page.getByRole("button", { name: "展开任务：订餐厅" })).toContainText("需要你操作浏览器");
    const primary = card.getByRole("button", { name: "去浏览器操作", exact: true });
    expect(await primary.evaluate((n) => getComputedStyle(n).color)).toBe("rgb(255, 255, 255)");
    await page.screenshot({ path: info.outputPath("browser-request.png"), fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);

    // Taking over opens the sandbox desktop (noVNC) with this task's window put on top.
    await card.getByRole("button", { name: "去浏览器操作", exact: true }).click();
    expect(controls).toEqual(["take"]);
    const panel = page.getByRole("dialog", { name: "操作任务页面" });
    await expect(panel).toContainText("OpenTable 登录");
    await expect(panel.locator('iframe[title="沙箱桌面"]')).toHaveAttribute("src", /vnc\.html/);
    await expect.poll(() => acts).toEqual([{ tab: "t1", action: "focus" }]);
    expect(tickets.at(-1)).toContain("/vnc/vnc.html");
    // Another window may have come up in the desktop: one tap puts this page back on top.
    await press(info, panel.getByRole("button", { name: "切回这个页面", exact: true }));
    await expect.poll(() => acts.length).toBe(2);
    expect(acts[1]).toEqual({ tab: "t1", action: "focus" });
    // The desktop fills the panel, and the panel fits the screen.
    const viewport = page.viewportSize()!;
    const desktop = (await panel.locator("iframe").boundingBox())!;
    expect(desktop.height).toBeGreaterThan(viewport.height * 0.5);
    expect(desktop.y + desktop.height).toBeLessThanOrEqual(viewport.height + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: info.outputPath("browser-console.png") });

    // Closing the panel keeps the tab yours; the card reopens it and hands it back.
    await panel.getByRole("button", { name: "关闭操作面板", exact: true }).click();
    await expect(panel).toBeHidden();
    const held = page.getByRole("group", { name: "任务浏览器：你正在操作" });
    await expect(held).toContainText("AI 已暂停操作这个页面");
    await held.getByRole("button", { name: "操作页面", exact: true }).click();
    await panel.getByRole("button", { name: "完成，交还给 AI", exact: true }).click();
    expect(controls).toEqual(["take", "release"]);
    await expect(panel).toBeHidden();
    await expect(page.getByRole("group", { name: "任务浏览器：AI 操作中" }).getByRole("button", { name: "接管", exact: true })).toBeVisible();
});
test("a link in a reply opens in the person's own tab, operated on the desktop like a hand-over", async ({ page }, info) => {
    const row: Task = { ...task(1, "completed"), title: "找餐厅", result: "推荐这家：[Nopa 订位](http://192.168.1.20/r/nopa)", completedAt: 2000 };
    const calls: Array<{ route: string; body: Record<string, unknown> }> = [];
    const order: string[] = [];
    await page.route("**/api/browser/person/*", async r => {
        const route = new URL(r.request().url()).pathname.split("/").pop()!;
        const body = r.request().postDataJSON();
        calls.push({ route, body });
        if (route === "pointer") order.push(`focus:${body.tab}`);
        await r.fulfill({ json: { title: "OpenTable", url: "http://192.168.1.20/r/nopa", closed: body.tab } });
    });
    const lease: string[] = [];
    await page.route("**/api/browser/viewer/heartbeat", r => { lease.push("heartbeat"); order.push("heartbeat"); return r.fulfill({ json: { ok: true, generation: 1, status: {} } }); });
    await page.route("**/api/browser/viewer/release", r => { lease.push("release"); return r.fulfill({ json: { ok: true } }); });
    await page.route("**/api/browser/wake", r => { lease.push("wake"); order.push("wake"); return r.fulfill({ json: { ok: true, status: {} } }); });
    await setup(page, [row]);
    const patchedUi = patchNoVncUi(fs.readFileSync(new URL("../fixtures/novnc-ui-1.4.0.js", import.meta.url), "utf8"))!;
    const relay = patchedUi.slice(patchedUi.indexOf("/* aio-agent: pinch scales the host preview */"), patchedUi.indexOf("\nexport default UI;"));
    await page.route("http://127.0.0.1:4289/**", r => r.fulfill({ contentType: "text/html", body: `<html class="aio-host-bar"><body style="margin:0;background:#eee"><div style="height:100%;background:repeating-linear-gradient(45deg,#eee,#eee 30px,#ccc 30px,#ccc 60px)">预览画面</div><script>${relay}</script></body></html>` }));
    await page.route("**/api/workspace/ticket", async r => { order.push("ticket"); await r.fulfill({ json: { ticket: "t", origin: "http://127.0.0.1:4289", url: "http://127.0.0.1:4289/vnc/vnc.html?ticket=t", expiresAt: Date.now() + 60_000 } }); });
    let opened: string | null = null;
    await page.route("**/api/browser/tabs", async r => {
        opened = r.request().postDataJSON().url;
        await new Promise(res => setTimeout(res, 300));
        await r.fulfill({ json: { ok: true, message: "已打开", data: null, tab: { id: "t8", key: "person", title: "OpenTable: Nopa", url: opened, createdAt: 1, lastUsed: 1, finishedAt: null, holder: "human", humanSince: 1, request: null } } });
    });
    await page.getByRole("link", { name: "Nopa 订位" }).click();
    await expect(page.getByRole("status")).toContainText("正在打开链接");
    const panel = page.getByRole("dialog", { name: "操作网页" });
    await expect(panel).toBeVisible();
    expect(opened).toBe("http://192.168.1.20/r/nopa");
    // No workspace, no host tab: the page is operated right here, on the desktop, with its window on top.
    await expect(page.locator(".workspace")).toHaveCount(0);
    expect(page.context().pages()).toHaveLength(1);
    await expect(panel).toContainText("OpenTable: Nopa");
    await expect(panel.locator('iframe[title="沙箱桌面"]')).toHaveAttribute("src", /vnc\.html/);
    // On a phone the desktop is 1.6 times the screen's width; a swipe on the black around it pans.
    const frame = panel.locator(".desktop-frame");
    const geometry = await frame.evaluate((el) => ({ box: el.clientWidth, frame: el.querySelector("iframe")!.getBoundingClientRect().width, scroll: el.scrollWidth }));
    if (info.project.name.startsWith("mobile")) {
        expect(Math.abs(geometry.frame - geometry.box * 1.6)).toBeLessThan(2);
        expect(geometry.scroll).toBeGreaterThan(geometry.box * 1.5);
        // It opens on the middle of the desktop, not its left edge.
        expect(Math.abs((await frame.evaluate((el) => el.scrollLeft)) - (geometry.scroll - geometry.box) / 2)).toBeLessThan(2);
        // The desktop's controls sit in the black strip under it, where noVNC's left bar used to be.
        const bar = panel.getByRole("toolbar", { name: "桌面操作" });
        await expect(bar).toContainText("双指缩放 · 左右滑动");
        for (const name of ["键盘", "粘贴", "回车", "Tab", "Esc"]) await expect(bar.getByRole("button", { name, exact: true })).toBeVisible();
        const fits = await bar.evaluate((el) => { const r = el.getBoundingClientRect(), p = el.closest(".desktop-frame")!.getBoundingClientRect(); return r.left >= p.left - 1 && r.right <= p.right + 1 && r.bottom <= p.bottom + 1; });
        expect(fits).toBe(true);
        await page.screenshot({ path: info.outputPath("desktop-bar.png") });
        await frame.evaluate((el) => { el.scrollLeft = 150; });
        expect(await frame.evaluate((el) => el.scrollLeft)).toBeGreaterThan(100);
        // Pinches on the framed desktop relay to the host; other windows cannot change the scale.
        const remote = page.frameLocator('iframe[title="沙箱桌面"]');
        const gesture = async (phase: string, magnitude: number) => {
            await remote.locator("body").evaluate((el, data) => el.dispatchEvent(new CustomEvent(data.phase, { detail: { type: "pinch", magnitudeX: data.magnitude, magnitudeY: 0, clientX: innerWidth / 2 } })), { phase, magnitude });
        };
        const picture = panel.locator('iframe[title="沙箱桌面"]');
        await gesture("gesturestart", 100);
        await gesture("gesturemove", 150);
        await expect.poll(async () => (await picture.boundingBox())!.width).toBeCloseTo(geometry.frame * 1.5, 0);
        await gesture("gestureend", 150);
        await gesture("gesturestart", 100);
        await gesture("gesturemove", 10);
        await expect.poll(async () => (await picture.boundingBox())!.width).toBeCloseTo(geometry.box, 0);
        await gesture("gestureend", 10);
        await gesture("gesturestart", 100);
        await gesture("gesturemove", 1000);
        await expect.poll(async () => (await picture.boundingBox())!.width).toBeCloseTo(Math.floor(geometry.box * 3.2), 0);
        await gesture("gestureend", 1000);
        await gesture("gesturestart", 100);
        await gesture("gesturemove", 62.5);
        await expect.poll(async () => (await picture.boundingBox())!.width).toBeCloseTo(geometry.box * 2, 0);
        await gesture("gestureend", 62.5);
        const originalWidth = (await picture.boundingBox())!.width;
        await page.evaluate(() => window.postMessage({ aio: "desktop", type: "pinch", phase: "move", ratio: 2, x: 0.5 }, "*"));
        expect((await picture.boundingBox())!.width).toBe(originalWidth);
        // Simulate an iPhone keyboard: only visualViewport shrinks, while layout width stays unchanged.
        // The page scale and pan must survive; the keyboard and key buttons remain usable above it.
        await press(info, bar.getByRole("button", { name: "键盘", exact: true }));
        await expect(panel.getByRole("textbox", { name: "输入到桌面" })).toBeFocused();
        const pan = await frame.evaluate((el) => el.scrollLeft);
        const before = await picture.boundingBox();
        await page.evaluate(() => {
            Object.defineProperty(window.visualViewport!, "height", { configurable: true, value: 480 });
            window.visualViewport!.dispatchEvent(new Event("resize"));
        });
        await expect.poll(() => page.locator(".task-console-overlay").evaluate((el) => el.clientHeight)).toBe(480);
        await expect.poll(async () => (await picture.boundingBox())!.width).toBeCloseTo(before!.width, 0);
        expect((await picture.boundingBox())!.height).toBeCloseTo(before!.height, 0);
        expect(await frame.evaluate((el) => el.scrollLeft)).toBeCloseTo(pan, 0);
        const keyboard = bar.getByRole("button", { name: "键盘", exact: true });
        const keyBox = (await keyboard.boundingBox())!;
        expect(keyBox.y).toBeGreaterThanOrEqual(0);
        expect(keyBox.y + keyBox.height).toBeLessThanOrEqual(480);
        await press(info, bar.getByRole("button", { name: "回车", exact: true }));
        await page.screenshot({ path: info.outputPath("browser-keyboard.png") });
        await page.evaluate(() => {
            delete (window.visualViewport! as unknown as Record<string, unknown>).height;
            window.visualViewport!.dispatchEvent(new Event("resize"));
        });
        await expect.poll(async () => (await picture.boundingBox())!.width).toBeCloseTo(before!.width, 0);
        await frame.evaluate((el) => { el.scrollLeft = 0; });
    } else {
        expect(Math.abs(geometry.frame - geometry.box)).toBeLessThan(2);
    }
    // The browser is kept awake (woken if it slept) before its window is raised; the desktop opens alongside.
    await expect.poll(() => order.includes("focus:t8")).toBe(true);
    const at = (step: string) => order.indexOf(step);
    expect(at("heartbeat")).toBeLessThan(at("wake"));
    expect(at("wake")).toBeLessThan(at("focus:t8"));
    expect(order).toContain("ticket");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: info.outputPath("link-console.png") });

    // Closing the panel closes the page, and lets the browser go idle again.
    await panel.getByRole("button", { name: "关闭操作面板" }).click();
    await expect(panel).toBeHidden();
    await expect.poll(() => lease.at(-1)).toBe("release");
    await expect.poll(() => calls.filter(c => c.route === "close").map(c => c.body.tab)).toEqual(["t8"]);
});
test("an HTML page too large to preview inline opens in full in the person's own browser tab", async ({ page }, info) => {
    const row: Task = { ...task(1, "completed"), title: "做报表", result: "做好了：[销售报表](/home/gem/workspace/report.html)", completedAt: 2000 };
    await page.route("**/api/browser/person/*", r => r.fulfill({ json: { title: "销售报表", url: "file:///home/gem/workspace/report.html", closed: r.request().postDataJSON().tab } }));
    await page.route("**/api/browser/viewer/heartbeat", r => r.fulfill({ json: { ok: true, generation: 1, status: {} } }));
    await page.route("**/api/browser/viewer/release", r => r.fulfill({ json: { ok: true } }));
    await page.route("**/api/browser/wake", r => r.fulfill({ json: { ok: true, status: {} } }));
    await setup(page, [row]);
    await page.route("**/api/workspace/ticket", r => r.fulfill({ json: { ticket: "t", origin: "http://127.0.0.1:4289", url: "http://127.0.0.1:4289/vnc/vnc.html?ticket=t", expiresAt: Date.now() + 60_000 } }));
    await page.route("**/api/documents/text**", r => r.fulfill({ status: 413, json: { error: "too_large", message: "文件 636.7 KB 超过内联显示上限（256.0 KB），请下载后查看" } }));
    const opened: string[] = [];
    await page.route("**/api/browser/files", async r => {
        opened.push(r.request().postDataJSON().path);
        await new Promise(res => setTimeout(res, 1200));
        await r.fulfill({ json: { ok: true, tab: { id: "t9", key: "person", title: "销售报表", url: "file:///home/gem/workspace/report.html", createdAt: 1, lastUsed: 1, finishedAt: null, holder: "human", humanSince: 1, request: null } } });
    });
    await page.getByRole("button", { name: "预览 销售报表" }).click();
    // While it loads: what is opening, and a way out.
    const card = page.locator(".opening-card");
    await expect(card).toContainText("正在打开页面");
    await expect(card).toContainText("report.html");
    await expect(card.getByRole("button", { name: "取消" })).toBeVisible();
    await page.waitForTimeout(350);
    await page.screenshot({ path: info.outputPath("opening-card.png") });
    // No dead end telling the person to download: the page opens in full, in the console, once.
    const panel = page.getByRole("dialog", { name: "操作网页" });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("销售报表");
    expect(opened).toEqual(["/home/gem/workspace/report.html"]);
    await expect(page.getByRole("dialog", { name: "预览 report.html" })).toHaveCount(0);
    await expect(page.getByText("超过内联显示上限")).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("large-html-console.png") });
    await panel.getByRole("button", { name: "关闭操作面板" }).click();
    await expect(panel).toBeHidden();

    // A page small enough to preview inline can still be opened in the browser from the preview.
    await page.unroute("**/api/documents/text**");
    await page.route("**/api/documents/text**", r => r.fulfill({ json: { text: "<h1>报表</h1>", truncated: false } }));
    await page.getByRole("button", { name: "预览 销售报表" }).click();
    const preview = page.getByRole("dialog", { name: "预览 report.html" });
    await preview.getByRole("button", { name: "在浏览器打开" }).click();
    await expect(panel).toBeVisible();
    await expect(preview).toHaveCount(0);
    expect(opened).toHaveLength(2);
    await panel.getByRole("button", { name: "关闭操作面板" }).click();

    // A browser that does not answer is never a dead end: cancelling leaves the conversation as it was.
    await page.unroute("**/api/browser/files");
    await page.route("**/api/browser/files", () => undefined);
    await page.getByRole("button", { name: "预览 销售报表" }).click();
    await page.getByRole("dialog", { name: "预览 report.html" }).getByRole("button", { name: "在浏览器打开" }).click();
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "取消" }).click();
    await expect(card).toHaveCount(0);
    await expect(panel).toHaveCount(0);
    await expect(page.getByRole("button", { name: "预览 销售报表" })).toBeVisible();
});
test("dispatching shows a calm sorting animation and what the dispatcher weighs, and stays still for reduced motion", async ({ page }, info) => {
    await setup(page, [{ ...task(1, "planning"), title: "帮我订周六晚上的餐厅" }]);
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
    const card = page.locator('[data-task-id="task-1"] .task-progress');
    await expect(card.locator(".task-progress-label")).toHaveText("正在分配");
    // Nothing has run yet: the card does not open empty details.
    await expect(page.getByRole("button", { name: /展开任务/ })).toHaveCount(0);
    await expect(card.locator(".task-summary")).not.toContainText("›");
    const glyph = card.locator(".dispatch-glyph i").first();
    await expect(glyph).toBeVisible();
    expect(await glyph.evaluate(n => getComputedStyle(n).animationName)).toBe("dispatch-sort");
    const hint = card.locator(".task-dispatch-hint");
    await expect(hint).toHaveText("理解你的需求");
    await expect(hint).toHaveText("对照进行中和历史任务", { timeout: 5000 });
    await page.screenshot({ path: info.outputPath("dispatching.png") });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await glyph.evaluate(n => getComputedStyle(n).animationName)).toBe("none");
    expect(await hint.locator("span").evaluate(n => getComputedStyle(n).animationName)).toBe("none");
});
test("a finished task's browser card stays inside the screen, however long the page title", async ({ page }, info) => {
    const row: Task = { ...task(1, "completed"), title: "核查 Amazon Baby Registry 额度实际花在哪里", result: "查到了。", completedAt: 2000, browser: { tabs: 1, request: null, human: false } };
    const title = "Amazon.com: Baby Registry: Hatch Baby completion discount purchase history and eligible orders";
    await page.route("**/api/tasks/task-1/browser", r => r.fulfill({ json: { tabs: [{ id: "t1", title, url: "https://www.amazon.com/baby-reg/completion-discount/purchase-history-and-more", lastUsed: 1, finishedAt: 2, holder: "ai", request: null }] } }));
    await page.route("**/api/tasks/task-1/browser/screenshot*", r => r.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64") }));
    await setup(page, [row]);
    const card = page.locator('.task-report .task-browser');
    await expect(card).toBeVisible();
    const report = (await page.locator(".task-report").boundingBox())!;
    const box = (await card.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(report.x + report.width + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    expect(await page.locator(".task-feed").evaluate(n => n.scrollWidth - n.clientWidth)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: info.outputPath("report-browser.png") });
});
test("only tasks that used the browser ask for their tabs", async ({ page }) => {
    const asked: string[] = [];
    await page.route("**/api/tasks/*/browser", r => { asked.push(new URL(r.request().url()).pathname.split("/")[3]!); return r.fulfill({ json: { tabs: [] } }); });
    await setup(page, [
        { ...task(1, "completed"), result: "好", completedAt: 2000 },
        { ...task(2, "completed"), result: "好", completedAt: 2001, browser: { tabs: 1, request: null, human: false } },
        { ...task(3, "running") },
    ]);
    await expect.poll(() => asked).toEqual(["task-2"]);
    await page.waitForTimeout(500);
    expect(asked).toEqual(["task-2"]);
});
test("a stuck first request never holds the page on loading", async ({ page }) => {
    await mockConsole(page, { conversations: [] });
    let calls = 0;
    await page.route("**/api/main*", r => (++calls === 1 ? new Promise(() => undefined) : r.fulfill({ json: { mode: "tasks", tasks: [], nextBefore: null } })));
    await page.clock.install();
    await page.goto("/");
    await expect(page.getByText("加载中…")).toBeVisible();
    await page.clock.fastForward(9000);
    await expect(page.getByRole("heading", { name: "主会话", exact: true })).toBeVisible();
});
test("tapping the preview watches the agent's page first; only taking over pauses the agent", async ({ page }, info) => {
    const row: Task = { ...task(1), title: "查摄影资料", browser: { tabs: 1, request: null, human: false } };
    const tab = { id: "t1", title: "DuckDuckGo 搜索", url: "https://html.duckduckgo.com/html/?q=exif", lastUsed: 1, finishedAt: null, holder: "ai" as "ai" | "human", request: null };
    const controls: string[] = [];
    await page.route("**/api/tasks/task-1/browser", r => r.fulfill({ json: { tabs: [tab] } }));
    await page.route("**/api/tasks/task-1/browser/screenshot*", r => r.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64") }));
    await page.route("**/api/tasks/task-1/browser/control", async r => {
        const { action } = r.request().postDataJSON();
        controls.push(action);
        tab.holder = action === "take" ? "human" : "ai";
        row.browser = { tabs: 1, request: null, human: tab.holder === "human" };
        await r.fulfill({ json: { tab } });
    });
    const focused: string[] = [];
    await page.route("**/api/tasks/task-1/browser/pointer", async r => { focused.push(r.request().postDataJSON().action); await r.fulfill({ json: { title: tab.title, url: tab.url } }); });
    await setup(page, [row]);
    const tickets: string[] = [];
    await page.route("**/api/workspace/ticket", async r => { tickets.push(r.request().postDataJSON().next); await r.fulfill({ json: { ticket: "t", origin: "http://127.0.0.1:4289", url: `http://127.0.0.1:4289/vnc/vnc.html?ticket=t${tickets.length}`, expiresAt: Date.now() + 60_000 } }); });

    const card = page.getByRole("group", { name: "任务浏览器：AI 操作中" });
    await press(info, card.getByRole("button", { name: "查看这个页面" }));
    const watch = page.getByRole("dialog", { name: "查看任务页面" });
    await expect(watch).toBeVisible();
    // Watching: the agent keeps its page, the desktop is view-only, the window is brought up.
    expect(controls).toEqual([]);
    await expect.poll(() => tickets.at(-1)).toContain("view_only=1");
    await expect.poll(() => focused).toEqual(["focus"]);
    await expect(watch).toContainText("AI 正在操作");
    await page.screenshot({ path: info.outputPath("watch-console.png") });

    // Taking over pauses the agent and makes the same desktop interactive.
    await press(info, watch.getByRole("button", { name: "人工接管", exact: true }));
    const operate = page.getByRole("dialog", { name: "操作任务页面" });
    await expect(operate).toBeVisible();
    expect(controls).toEqual(["take"]);
    await expect.poll(() => tickets.at(-1)).not.toContain("view_only");
    await press(info, operate.getByRole("button", { name: "完成，交还给 AI", exact: true }));
    expect(controls).toEqual(["take", "release"]);
    await expect(operate).toBeHidden();
});
test("owner debug mode shows each message's dispatch log step by step", async ({ page }, info) => {
    const trip = { ...task(1, "completed"), title: "规划行程", text: "规划东京三天", result: "好的，要再加美食推荐吗？", completedAt: Date.now() };
    const reply = { ...task(2, "completed"), title: "美食推荐", text: "要", relatedTaskId: "task-1", result: "推荐如下", completedAt: Date.now() };
    await page.route("**/api/settings/dispatch-log/task-2", r => r.fulfill({ json: { task: { id: "task-2", title: "美食推荐", text: "要", status: "completed" }, entries: [{
        at: Date.now(), latencyMs: 2400, rounds: 1, promptChars: 5200, failed: false, failReason: null, repairs: [],
        candidates: [{ id: "task-1", source: "recent", title: "规划行程" }],
        searches: [], chosen: { related: ["task-1"], appendTo: null, resume: "task-1" }, jev: { choice: "task-1", probability: 0.99, confident: true, latencyMs: 140 },
        steps: [
            { kind: "context", at: Date.now(), timeline: "  [14:00] 用户：「规划东京三天」 → 任务 task-1「规划行程」（completed）；助理最后问：「要再加美食推荐吗？」\n▶ [14:05] 用户：「要」  ← 本次消息", candidates: 1 },
            { kind: "jev", at: Date.now(), criteria: { "resume:task-1": "第1近（14:00）「规划行程」", NEW: "独立新请求" }, result: { choice: "task-1", probabilities: { "task-1": 0.99, NEW: 0.01 }, scores:{"task-1":0.94}, suggestion:{kind:"resume",taskId:"task-1",probability:0.99}, confident: true, latencyMs: 140 } },
            { kind: "timing", at: Date.now(), round: 1, timing: { model: "gpt-6-luna", effort: "low", sandboxMs: 1, connectionMs: 0, threadStartMs: 60, turnStartMs: 35, firstTextMs: 900, finishMs: 120, classifierMs: 1115, totalMs: 1116 } },
            { kind: "ask", at: Date.now(), round: 1, prompt: "你是 AIO Agent 的 Luna 派单器……", answer: "{\"title\":\"美食推荐\",\"decision\":{\"kind\":\"resume\",\"taskId\":\"task-1\"}}" },
            { kind: "plan", at: Date.now(), plan: { title: "美食推荐", description:"补充东京美食推荐",decision:{kind:"resume",taskId:"task-1"}, resume: "task-1", related: ["task-1"] }, repairs: [] },
        ],
    }] } }));
    await setup(page, [trip, reply]);
    // Off by default: nothing extra on the messages.
    await expect(page.getByRole("button", { name: /派单日志/ })).toHaveCount(0);
    await page.evaluate(() => localStorage.setItem("aio.debug", "1"));
    await page.reload();
    await expect(page.getByRole("button", { name: "派单日志：美食推荐" })).toBeVisible();
    await press(info, page.getByRole("button", { name: "派单日志：美食推荐" }));
    const dialog = page.getByRole("dialog", { name: "派单日志" });
    await expect(dialog).toContainText("续接「规划行程」的原执行会话");
    await expect(dialog).toContainText("助理最后问：「要再加美食推荐吗？」");
    await expect(dialog).toContainText("建议 续接「规划行程」（99%，高置信，140 ms）");
    await expect(dialog).toContainText("规划行程 · 相关性 94%");
    await expect(dialog).toContainText("派单器第 1 轮");
    await expect(dialog).toContainText("gpt-6-luna · high");
    await expect(dialog).toContainText("提交至首字 900 ms");
    await expect(dialog).toContainText("\"resume\": \"task-1\"");
    await dialog.getByText(/完整提示词/).click();
    await expect(dialog).toContainText("你是 AIO Agent 的 Luna 派单器");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath("dispatch-log.png") });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
});
