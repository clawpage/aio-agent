import { test, expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { makeConversation, mockConsole } from "./mock-api";
import type { Task } from "../../src/web/src/types";
import fs from "node:fs";
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
test("MP4 attachments and results preview directly in the main inbox",async({page},info)=>{
    const path='/home/gem/workspace/uploads/demo.mp4';
    const row={...task(1,'completed'),attachments:[{name:'demo.mp4',path,kind:'file' as const,size:3641}],result:`[视频结果](${path})`,completedAt:Date.now()};
    await page.route('**/api/documents/video**',r=>r.fulfill({contentType:'video/mp4',body:fs.readFileSync(new URL('../fixtures/preview.mp4',import.meta.url))}));
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
    await setup(page,[task(1)],1000);
    await page.route('**/api/main*',r=>r.fulfill({json:new URL(r.request().url()).searchParams.has('before')?{mode:'tasks',tasks:[{...task(99,'completed'),result:'Old result',completedAt:999}],nextBefore:null}:{mode:'tasks',tasks:[task(1)],nextBefore:1000}}));
    if(info.project.name.startsWith('mobile'))await page.getByRole('button',{name:'打开导航'}).click();await page.locator('.sidebar').getByRole('button',{name:'任务列表',exact:true}).click();
    await page.getByRole('button',{name:'加载更早的任务',exact:true}).click();await expect(page.getByRole('button',{name:'打开任务：任务 99',exact:true})).toBeVisible();
    await expect(page.locator('.task-list-item')).toHaveCount(2);await expect(page.locator('.task-list-page').getByRole('button',{name:'加载更早的任务',exact:true})).toHaveCount(0);
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
    const row: Task = { ...task(1, "completed"), title: "找餐厅", result: "推荐这家：[Nopa 订位](https://www.opentable.com/r/nopa)", completedAt: 2000 };
    const calls: Array<{ route: string; body: Record<string, unknown> }> = [];
    const order: string[] = [];
    await page.route("**/api/browser/person/*", async r => {
        const route = new URL(r.request().url()).pathname.split("/").pop()!;
        const body = r.request().postDataJSON();
        calls.push({ route, body });
        if (route === "pointer") order.push(`focus:${body.tab}`);
        await r.fulfill({ json: { title: "OpenTable", url: "https://www.opentable.com/r/nopa", closed: body.tab } });
    });
    const lease: string[] = [];
    await page.route("**/api/browser/viewer/heartbeat", r => { lease.push("heartbeat"); order.push("heartbeat"); return r.fulfill({ json: { ok: true, generation: 1, status: {} } }); });
    await page.route("**/api/browser/viewer/release", r => { lease.push("release"); return r.fulfill({ json: { ok: true } }); });
    await page.route("**/api/browser/wake", r => { lease.push("wake"); order.push("wake"); return r.fulfill({ json: { ok: true, status: {} } }); });
    await setup(page, [row]);
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
    expect(opened).toBe("https://www.opentable.com/r/nopa");
    // No workspace, no host tab: the page is operated right here, on the desktop, with its window on top.
    await expect(page.locator(".workspace")).toHaveCount(0);
    expect(page.context().pages()).toHaveLength(1);
    await expect(panel).toContainText("OpenTable: Nopa");
    await expect(panel.locator('iframe[title="沙箱桌面"]')).toHaveAttribute("src", /vnc\.html/);
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
