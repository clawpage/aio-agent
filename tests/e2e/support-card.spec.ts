import { test, expect } from '@playwright/test';
import { mockConsole } from './mock-api';

// A 1×1 PNG for the workspace image the card shows.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const base = { revision: 1, conversationId: 'conv', error: null, attachments: [], completedAt: Date.now() - 30_000 };

test('a support card reads as a message from support, not as something the person typed', async ({ page }, info) => {
  await mockConsole(page, { conversations: [] });
  await page.route('**/api/auth/session', r => r.fulfill({ json: { authenticated: true, username: 'member', role: 'member' } }));
  await page.route('**/api/documents/image*', r => r.fulfill({ body: PNG, contentType: 'image/png' }));
  const tasks = [
    { ...base, id: 'asked', title: '改辅食表', text: '把冲调备注改成水或奶', status: 'completed', result: '已改好。', createdAt: Date.now() - 120_000, completedAt: Date.now() - 90_000, clientMessageId: 'c1' },
    { ...base, id: 'card', title: 'Roy 辅食表清晰版', text: '', status: 'completed', support: true, clientMessageId: 'support:roy-week1', createdAt: Date.now() - 60_000, completedAt: Date.now() - 60_000,
      result: '辅食表重做好了，文字都清晰。\n\n![Roy 第一周辅食计划](/home/gem/workspace/tasks/roy-week1-html/roy-week1.png)' },
  ];
  await page.route('**/api/main*', r => r.fulfill({ json: { mode: 'tasks', tasks, nextBefore: null } }));
  await page.goto('/');

  const entry = page.locator('.task-entry[data-task-id="card"]');
  await expect(entry.getByRole('note')).toContainText('客服发来的消息');
  // No empty "your message" bubble for a card nobody typed; the person's own task keeps its bubble.
  await expect(entry.locator('.msg.user')).toHaveCount(0);
  // Created and finished at once: the note sits right above its own card, after the earlier reply.
  const order = await page.locator('.task-feed > *').evaluateAll(els => els.map(e => e.getAttribute('data-task-id') + (e.classList.contains('task-report') ? ':report' : '')));
  expect(order.filter(id => /^(asked|card)/.test(id))).toEqual(['asked', 'asked:report', 'card', 'card:report']);
  await expect(page.locator('.task-entry[data-task-id="asked"] .msg.user')).toContainText('把冲调备注改成水或奶');

  const card = page.locator('.task-report[data-task-id="card"]');
  await expect(card.locator('.task-report-heading')).toContainText('Roy 辅食表清晰版');
  await expect(card.locator('.schedule-badge')).toHaveText('客服');
  await expect(card).toContainText('辅食表重做好了');
  await expect(card.locator('img[data-sandbox-image]')).toHaveCount(1);
  // It can be quoted for a follow-up, but there is no AI reply in it to report.
  await expect(card.getByRole('button', { name: '引用任务：Roy 辅食表清晰版' })).toBeVisible();
  await expect(card.getByRole('button', { name: '举报回复' })).toHaveCount(0);
  await expect(page.locator('.task-report[data-task-id="asked"]').getByRole('button', { name: '举报回复' })).toBeVisible();

  await expect(page.locator('.boot-cover')).toHaveCount(0);
  for (const width of info.project.name.startsWith('mobile') ? [390, 360] : [1440]) {
    await page.setViewportSize({ width, height: info.project.name.startsWith('mobile') ? 844 : 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await entry.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`support-card-${width}.png`) });
  }
});
