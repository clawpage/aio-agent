import { test, expect, type Page } from '@playwright/test';
import { mockConsole } from './mock-api';

// The executor's stream, driven from the test: a stand-in EventSource the page opens like the real one.
const fakeEventSource = () => {
  const sources: Record<string, FakeSource> = {};
  class FakeSource {
    listeners: Record<string, Array<(e: MessageEvent) => void>> = {};
    onmessage: ((e: MessageEvent) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public url: string) { sources[decodeURIComponent(url.split('/api/conversations/')[1]!.split('/')[0]!)] = this; }
    addEventListener(type: string, fn: (e: MessageEvent) => void) { (this.listeners[type] ??= []).push(fn); }
    close() {}
    emit(type: string, data: unknown) { for (const fn of this.listeners[type] ?? []) fn(new MessageEvent(type, { data: JSON.stringify(data) })); }
  }
  (window as unknown as { EventSource: unknown }).EventSource = FakeSource;
  (window as unknown as { __sources: typeof sources }).__sources = sources;
};

let nextId = 1;
const emit = (page: Page, type: string, payload: unknown) => page.evaluate(([type, payload, id]) => {
  const source = (window as unknown as { __sources: Record<string, { emit(t: string, d: unknown): void }> }).__sources.exec;
  source!.emit(type as string, { id, conversationId: 'exec', turnId: 't1', type, payload, createdAt: Date.now() });
}, [type, payload, nextId++] as const);
const started = (id: string, phase: string) => ({ item: { type: 'agentMessage', id, text: '', phase } });
const delta = (itemId: string, d: string) => ({ itemId, kind: 'item/agentMessage/delta', delta: d });

const ANSWER = '**明天晴，适合出游。**最高 24°C，早晚凉，带件薄外套。\n\n推荐这两处：\n\n```cards\n[{"title":"湖边步道","text":"平缓好走"}]\n```\n\n还需要我订餐厅吗？';

test('the main session writes out the final answer as the executor writes it, and the reply takes its place', async ({ page }, info) => {
  nextId = 1;
  await page.addInitScript(fakeEventSource);
  await mockConsole(page, { conversations: [] });
  const task: Record<string, unknown> = { id: 'live', revision: 1, title: '明天天气', text: '明天适合出去玩吗', conversationId: 'exec', status: 'running', result: null, error: null, attachments: [], relatedTaskId: null, dependencies: [], approvals: 0, createdAt: Date.now() - 60_000, startedAt: Date.now() - 50_000, completedAt: null, messages: ['我查一下明天的预报。'] };
  await page.route('**/api/main*', r => r.fulfill({ json: { mode: 'tasks', tasks: [task], nextBefore: null, version: `v${task.status}` } }));
  await page.goto('/');
  await expect(page.locator('.task-progress[data-progress-for="live"]')).toContainText('我查一下明天的预报。');
  await expect.poll(() => page.evaluate(() => 'exec' in ((window as unknown as { __sources: object }).__sources))).toBe(true);
  await emit(page, 'item/started', started('c1', 'commentary'));
  await emit(page, 'stream.delta', delta('c1', '我查一下明天的预报。'));
  // Working out loud is not the answer: no reply yet.
  const draft = page.locator('.task-report.drafting[data-task-id="live"]');
  await expect(draft).toHaveCount(0);

  await emit(page, 'item/started', started('f1', 'final_answer'));
  const cut = ANSWER.indexOf('[{') + 6;
  await emit(page, 'stream.delta', delta('f1', ANSWER.slice(0, cut)));
  await expect(draft).toBeVisible();
  await expect(draft.locator('.task-report-heading')).toContainText('正在回复');
  await expect(draft).toContainText('明天晴，适合出游。');
  await expect(draft).toContainText('推荐这两处');
  // A card half written waits for its closing fence instead of showing as raw code.
  await expect(draft).not.toContainText('```');
  await expect(draft).not.toContainText('[{');
  await emit(page, 'stream.delta', delta('f1', ANSWER.slice(cut)));
  await expect(draft).toContainText('湖边步道');
  await expect(draft).toContainText('还需要我订餐厅吗？');
  await draft.evaluate(el => { el.dataset.same = 'yes'; });
  await expect(page.locator('.boot-cover')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('drafting.png') });
  for (const width of info.project.name.startsWith('mobile') ? [390, 360] : [1440]) {
    await page.setViewportSize({ width, height: info.project.name.startsWith('mobile') ? 844 : 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  }

  // The answer is done: the finished reply takes the same place, without coming in again.
  await emit(page, 'item/completed', { item: { type: 'agentMessage', id: 'f1', text: ANSWER, phase: 'final_answer' } });
  await emit(page, 'turn.finished', { turnId: 't1' });
  Object.assign(task, { status: 'completed', result: ANSWER, completedAt: Date.now(), messages: [] });
  const reply = page.locator('.task-report.completed[data-task-id="live"]');
  await expect(reply).toBeVisible();
  await expect(draft).toHaveCount(0);
  await expect(page.locator('.task-report[data-task-id="live"]')).toHaveCount(1);
  await expect(reply).toHaveAttribute('data-same', 'yes');
  await expect(reply).toContainText('湖边步道');
});

test('an answer overtaken by a supplement leaves the feed until the executor answers again', async ({ page }) => {
  nextId = 1;
  await page.addInitScript(fakeEventSource);
  await mockConsole(page, { conversations: [] });
  const task = { id: 'live', revision: 1, title: '明天天气', text: '明天适合出去玩吗', conversationId: 'exec', status: 'running', result: null, error: null, attachments: [], relatedTaskId: null, dependencies: [], approvals: 0, createdAt: Date.now() - 60_000, startedAt: Date.now() - 50_000, completedAt: null, messages: [] };
  await page.route('**/api/main*', r => r.fulfill({ json: { mode: 'tasks', tasks: [task], nextBefore: null, version: 'v1' } }));
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => 'exec' in ((window as unknown as { __sources: object }).__sources))).toBe(true);
  await emit(page, 'item/started', started('f1', 'final_answer'));
  await emit(page, 'stream.delta', delta('f1', '明天晴。'));
  const draft = page.locator('.task-report.drafting[data-task-id="live"]');
  await expect(draft).toContainText('明天晴。');
  await emit(page, 'turn.input_appended', { text: '改成后天' });
  await expect(draft).toHaveCount(0);
  await emit(page, 'item/started', started('f2', 'final_answer'));
  await emit(page, 'stream.delta', delta('f2', '后天有雨。'));
  await expect(draft).toContainText('后天有雨。');
  await expect(draft).not.toContainText('明天晴');
});

test('the feed can be scrolled up while an answer is being written, and follows again back at the bottom', async ({ page }, info) => {
  nextId = 1;
  await page.addInitScript(fakeEventSource);
  await mockConsole(page, { conversations: [] });
  const long = Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 段：这是一段较长的已完成回复，用来让主会话可以滚动。`).join('\n\n');
  const done = Array.from({ length: 4 }, (_, i) => ({ id: `old${i}`, revision: 1, title: `旧任务 ${i}`, text: `问题 ${i}`, conversationId: `c${i}`, status: 'completed', result: long, error: null, attachments: [], relatedTaskId: null, dependencies: [], approvals: 0, createdAt: Date.now() - 600_000 + i * 1000, startedAt: null, completedAt: Date.now() - 500_000 + i * 1000, messages: [] }));
  const task = { id: 'live', revision: 1, title: '明天天气', text: '明天适合出去玩吗', conversationId: 'exec', status: 'running', result: null, error: null, attachments: [], relatedTaskId: null, dependencies: [], approvals: 0, createdAt: Date.now() - 60_000, startedAt: Date.now() - 50_000, completedAt: null, messages: [] };
  await page.route('**/api/main*', r => r.fulfill({ json: { mode: 'tasks', tasks: [...done, task], nextBefore: null, version: 'v1' } }));
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => 'exec' in ((window as unknown as { __sources: object }).__sources))).toBe(true);
  await emit(page, 'item/started', started('f1', 'final_answer'));
  // The executor keeps writing, a piece every 60ms, the whole time.
  await page.evaluate(() => {
    const source = (window as unknown as { __sources: Record<string, { emit(t: string, d: unknown): void }> }).__sources.exec!;
    let id = 1000;
    (window as unknown as { __pump: number }).__pump = window.setInterval(() => source.emit('stream.delta', { id: id++, conversationId: 'exec', turnId: 't1', type: 'stream.delta', payload: { itemId: 'f1', kind: 'item/agentMessage/delta', delta: '明天晴，适合出游，记得带外套。' }, createdAt: Date.now() }), 60);
  });
  const feed = page.locator('.task-feed');
  const fromBottom = () => feed.evaluate(n => n.scrollHeight - n.scrollTop - n.clientHeight);
  await expect(page.locator('.task-report.drafting[data-task-id="live"]')).toBeVisible();
  await expect(page.locator('.boot-cover')).toHaveCount(0);
  await expect.poll(fromBottom).toBeLessThan(5);
  const box = (await feed.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  // A wheel, or (mobile WebKit has none) a finger: down, the feed moves under it, up.
  const nudge = (dy: number) => info.project.name === 'mobile-webkit'
    ? feed.evaluate((n, dy) => new Promise(done => {
      const fire = (type: string) => n.dispatchEvent(new Event(type, { bubbles: true }));
      fire('touchstart'); n.scrollTop += dy; fire('touchmove');
      setTimeout(() => { fire('touchend'); done(null); }, 50);
    }), dy)
    : page.mouse.wheel(0, dy);
  // A small nudge up stays where the person left it, not snapped back to the bottom.
  await nudge(-40);
  await page.waitForTimeout(600);
  expect(await fromBottom()).toBeGreaterThan(20);
  await nudge(-600);
  await page.waitForTimeout(800);
  expect(await fromBottom()).toBeGreaterThan(300);
  const top = await feed.evaluate(n => n.scrollTop);
  await page.waitForTimeout(800);
  expect(Math.abs(await feed.evaluate(n => n.scrollTop) - top)).toBeLessThan(2);
  // Back at the bottom it follows the writing again.
  await nudge(5000);
  await page.waitForTimeout(300);
  await expect.poll(fromBottom).toBeLessThan(5);
  await page.evaluate(() => clearInterval((window as unknown as { __pump: number }).__pump));
});
