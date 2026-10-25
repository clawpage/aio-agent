import { test, expect, type Page } from '@playwright/test';
import { mockConsole } from './mock-api';

const base = { revision: 1, conversationId: 'conv', error: null, attachments: [], createdAt: Date.now() - 120_000, completedAt: Date.now() - 60_000 };

const RICH = `**已整理好，推荐 Sony XM6。**降噪最好。\n\n| 型号 | 价格 |\n| --- | --- |\n| Sony XM6 | $399 |\n| Bose QC Ultra | $429 |\n\n详情见[官网](https://www.sony.com/xm6)，表格在[对比表](/home/gem/workspace/tasks/rich/对比.xlsx)。\n\n`
  + "```cards\n[{\"title\":\"Sony XM6\",\"text\":\"降噪最好\",\"price\":\"$399\",\"url\":\"https://www.sony.com/xm6\"}]\n```"
  + `\n\n要我下单吗？\n\n`
  + "```choices\n[\"下单\", \"再看看\"]\n```";

const EXPECTED = '已整理好，推荐 Sony XM6。降噪最好。\n\n型号\t价格\nSony XM6\t$399\nBose QC Ultra\t$429\n\n详情见官网 (https://www.sony.com/xm6)，表格在对比表。\n\nSony XM6\n$399\n降噪最好\nhttps://www.sony.com/xm6\n\n要我下单吗？';

const tasks = [
  { ...base, id: 'fail', title: '查快递', text: '查一下快递到哪了', status: 'failed', result: null, error: '执行失败：网络中断', createdAt: Date.now() - 300_000, completedAt: Date.now() - 280_000 },
  { ...base, id: 'part', title: '比价三家店', text: '比一下三家店的价格', status: 'failed', result: '已查到 2 家，第三家网站打不开。', error: '执行失败：第三家网站超时', createdAt: Date.now() - 240_000, completedAt: Date.now() - 200_000 },
  { ...base, id: 'rich', title: '耳机对比', text: '帮我比一下降噪耳机', status: 'completed', result: RICH },
];

async function open(page: Page) {
  await mockConsole(page, { conversations: [] });
  await page.route('**/api/auth/session', r => r.fulfill({ json: { authenticated: true, username: 'member', role: 'member' } }));
  await page.route('**/api/main*', r => r.fulfill({ json: { mode: 'tasks', tasks, nextBefore: null } }));
  await page.goto('/');
  const rich = page.locator('.task-report[data-task-id="rich"]');
  await expect(rich).toContainText('降噪最好');
  await expect(page.locator('.boot-cover')).toHaveCount(0);
  return rich;
}

/** A clipboard that records what was written, or refuses. */
function stubClipboard(page: Page, refuse: boolean) {
  return page.addInitScript((refuse) => {
    const w = window as unknown as { __copied?: string };
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (text: string) => refuse ? Promise.reject(new Error('denied')) : (w.__copied = text, Promise.resolve()) },
    });
  }, refuse);
}

test('T1: 复制 puts the reply on the clipboard as plain text, then says 已复制 for a moment', async ({ page }) => {
  await stubClipboard(page, false);
  const rich = await open(page);
  const copy = rich.getByRole('button', { name: '复制回复：耳机对比', exact: true });
  await expect(copy).toHaveText('复制');
  await copy.click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __copied?: string }).__copied)).toBe(EXPECTED);
  const button = rich.locator('.copy-reply');
  await expect(button).toHaveText('已复制');
  await expect(button).toHaveAttribute('data-state', 'copied');
  await expect(button).not.toHaveAttribute('aria-label');
  // The confirmation takes the done color (after the buttons' short color transition).
  const done = await page.evaluate(() => { const d = document.createElement('i'); d.style.color = 'var(--done)'; document.body.append(d); const v = getComputedStyle(d).color; d.remove(); return v; });
  await expect.poll(() => button.evaluate(el => getComputedStyle(el).color)).toBe(done);
  await expect(button).toHaveText('复制', { timeout: 3000 });
  await expect(button).toHaveAttribute('data-state', 'idle');
  await expect(button).toHaveAttribute('aria-label', '复制回复：耳机对比');
});

test('T2: only replies with text get 复制, between 重试 and 引用任务, with 举报回复 last', async ({ page }) => {
  await stubClipboard(page, false);
  await open(page);
  const fail = page.locator('.task-report[data-task-id="fail"]');
  await expect(fail).toContainText('执行失败：网络中断');
  await expect(fail.locator('.copy-reply')).toHaveCount(0);
  const part = page.locator('.task-report[data-task-id="part"]');
  await expect(part.locator('.task-actions button')).toHaveText(['重试', '复制', '引用任务', '查看过程', '举报回复']);
  // The user's own messages never get one.
  await expect(page.locator('.task-entry .copy-reply')).toHaveCount(0);
});

test('T3: when the clipboard API refuses, the selection fallback copies, and a failed copy says so', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(String(e)));
  await stubClipboard(page, true);
  await page.addInitScript(() => {
    const w = window as unknown as { __exec: string | null; __execResult: boolean };
    w.__execResult = true;
    w.__exec = null;
    document.execCommand = (command: string) => {
      const el = document.activeElement;
      if (command === 'copy') w.__exec = el instanceof HTMLTextAreaElement ? el.value.slice(el.selectionStart, el.selectionEnd) : null;
      return w.__execResult;
    };
  });
  const rich = await open(page);
  const button = rich.locator('.copy-reply');
  await button.click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __exec: string | null }).__exec)).toBe(EXPECTED);
  await expect(button).toHaveText('已复制');
  // The hidden textarea is gone again.
  await expect(page.locator('body > textarea')).toHaveCount(0);
  await expect(button).toHaveText('复制', { timeout: 3000 });

  await page.evaluate(() => { (window as unknown as { __execResult: boolean }).__execResult = false; });
  await button.click();
  await expect(button).toHaveText('复制失败，请长按选择');
  await expect(button).toHaveAttribute('data-state', 'failed');
  const error = await page.evaluate(() => { const d = document.createElement('i'); d.style.color = 'var(--error)'; document.body.append(d); const v = getComputedStyle(d).color; d.remove(); return v; });
  await expect.poll(() => button.evaluate(el => getComputedStyle(el).color)).toBe(error);
  await expect(button).toHaveText('复制', { timeout: 4000 });
  expect(errors).toEqual([]);
});

test('T4: the real clipboard holds the plain text', async ({ page, context }, info) => {
  test.skip(info.project.name === 'mobile-webkit', 'WebKit gives no clipboard permissions to grant');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const rich = await open(page);
  await rich.locator('.copy-reply').click();
  await expect(rich.locator('.copy-reply')).toHaveText('已复制');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(EXPECTED);
});

test('T5: the action row wraps inside the reply at every width, and 复制 is as tall as 引用任务', async ({ page }) => {
  await stubClipboard(page, false);
  const rich = await open(page);
  for (const [width, height] of [[1440, 900], [390, 844], [360, 780]] as const) {
    await page.setViewportSize({ width, height });
    await rich.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), `${width}`).toBeLessThanOrEqual(1);
    const box = (await rich.boundingBox())!;
    for (const b of await rich.locator('.task-actions button').all()) {
      const r = (await b.boundingBox())!;
      expect(r.x, `${width} ${await b.textContent()}`).toBeGreaterThanOrEqual(box.x - 0.5);
      expect(r.x + r.width, `${width} ${await b.textContent()}`).toBeLessThanOrEqual(box.x + box.width + 0.5);
    }
    const [copy, quote] = await Promise.all([rich.locator('.copy-reply').boundingBox(), rich.getByRole('button', { name: '引用任务：耳机对比' }).boundingBox()]);
    expect(Math.abs(copy!.height - quote!.height), `${width}`).toBeLessThanOrEqual(1);
  }
});
