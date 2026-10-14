import { test, expect } from '@playwright/test';
import { mockConsole } from './mock-api';

const base = { revision: 1, conversationId: 'conv', error: null, attachments: [], createdAt: Date.now() - 60_000, completedAt: Date.now() - 30_000 };

test('a failed card retries its request once as a follow-up, and the report link stays quiet at the end of a reply', async ({ page }, info) => {
  await mockConsole(page, { conversations: [] });
  await page.route('**/api/auth/session', r => r.fulfill({ json: { authenticated: true, username: 'member', role: 'member' } }));
  const tasks: Array<Record<string, unknown>> = [
    { ...base, id: 'done', title: 'Done task', text: 'first question', status: 'completed', result: 'An answer', createdAt: Date.now() - 120_000 },
    { ...base, id: 'broken', title: 'Broken task', text: '帮我整理附件', status: 'failed', result: null, error: '执行失败：网络中断', attachments: [{ path: '/home/gem/workspace/uploads/a.pdf', kind: 'file', name: 'a.pdf' }] },
  ];
  await page.route('**/api/main*', r => r.fulfill({ json: { mode: 'tasks', tasks, nextBefore: null } }));
  const sent: unknown[] = [];
  await page.route('**/api/tasks', async r => {
    const body = r.request().postDataJSON(); sent.push(body);
    const task = { ...base, id: 'again', title: 'Broken task', text: body.text, status: 'planning', result: null, completedAt: null, relatedTaskId: body.relatedTaskId, clientMessageId: body.clientMessageId, createdAt: Date.now() };
    tasks.push(task);
    await r.fulfill({ status: 202, json: { task, duplicate: false } });
  });
  await page.goto('/');
  const failed = page.locator('.task-report[data-task-id="broken"]');
  await expect(failed).toContainText('执行失败：网络中断');
  // A failed card has no reply to report; the finished one keeps a quiet link after its actions.
  await expect(failed.getByRole('button', { name: '举报回复' })).toHaveCount(0);
  const done = page.locator('.task-report[data-task-id="done"]');
  const report = done.getByRole('button', { name: '举报回复', exact: true });
  await expect(report).toBeVisible();
  const [quote, link] = await Promise.all([done.getByRole('button', { name: '引用任务：Done task' }).boundingBox(), report.boundingBox()]);
  expect(link!.x).toBeGreaterThan(quote!.x);
  expect(await report.evaluate(el => [getComputedStyle(el).borderTopWidth, getComputedStyle(el).backgroundColor])).toEqual(['0px', 'rgba(0, 0, 0, 0)']);
  await expect(done.getByRole('button', { name: /^重试/ })).toHaveCount(0);
  await expect(page.locator('.boot-cover')).toHaveCount(0);
  await failed.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('failed-card.png') });
  const retry = failed.getByRole('button', { name: '重试任务：Broken task', exact: true });
  await retry.click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toMatchObject({ text: '帮我整理附件', relatedTaskId: 'broken', clientMessageId: expect.stringMatching(/^retry:broken:1$/), attachments: [{ path: '/home/gem/workspace/uploads/a.pdf', kind: 'file', name: 'a.pdf' }] });
  // Once followed up, the failed card no longer offers a retry.
  await expect(retry).toHaveCount(0);
  for (const width of info.project.name.startsWith('mobile') ? [390, 360] : [1440]) {
    await page.setViewportSize({ width, height: info.project.name.startsWith('mobile') ? 844 : 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  }
});
