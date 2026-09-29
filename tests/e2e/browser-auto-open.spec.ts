import { expect, test } from "@playwright/test";
import { makeConversation, mockConsole, type MockConversation } from "./mock-api";

// Agent navigation must never change the user-selected workspace view.

const CONV_ID = "conv_e2e_auto_browser";
const conversations: MockConversation[] = [makeConversation(CONV_ID, "自动浏览器")];

function itemStarted(id: number, item: Record<string, unknown>): string {
  const event = { id, type: "item/started", turnId: "t1", createdAt: Date.now(), payload: { item } };
  return `id: ${id}\nevent: item/started\ndata: ${JSON.stringify(event)}\n\n`;
}

function replayComplete(lastEventId: number): string {
  return `event: replay.complete\ndata: ${JSON.stringify({ lastEventId, replayed: lastEventId })}\n\n`;
}

function sse(...frames: string[]): string {
  return ["retry: 3000\n\n", ...frames].join("");
}

test.describe("agent browser navigation", () => {
  test("a live aio browser navigate command leaves the workspace closed", async ({ page }) => {
    await page.bringToFront();
    await mockConsole(page, {
      conversations,
      sse: {
        [CONV_ID]: sse(
          replayComplete(0),
          itemStarted(1, { id: "i1", type: "commandExecution", command: "aio browser navigate https://example.com" }),
        ),
      },
    });

    await page.goto("/");
    await expect(page.locator(".chat")).toBeVisible();
    await expect(page.locator(".working")).toBeVisible();
    await expect(page.locator(".workspace")).toHaveCount(0);
  });

  test("a replayed navigation command (before replay.complete) does not open the workspace", async ({ page }) => {
    await page.bringToFront();
    await mockConsole(page, {
      conversations,
      sse: {
        [CONV_ID]: sse(
          itemStarted(1, { id: "i1", type: "commandExecution", command: "aio browser navigate https://example.com" }),
          replayComplete(1),
        ),
      },
    });

    await page.goto("/");
    await expect(page.locator(".chat")).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(1200);
    await expect(page.locator(".workspace")).toHaveCount(0);
  });

  test("a command that only mentions navigation, or another browser action, does not open the workspace", async ({ page }) => {
    await page.bringToFront();
    await mockConsole(page, {
      conversations,
      sse: {
        [CONV_ID]: sse(
          replayComplete(0),
          itemStarted(1, { id: "i1", type: "commandExecution", command: "echo 'aio browser navigate https://example.com'" }),
          itemStarted(2, { id: "i2", type: "commandExecution", command: "aio browser screenshot -o shot.png" }),
          itemStarted(3, { id: "i3", type: "mcpToolCall", server: "aio_browser", tool: "browser_screenshot" }),
          itemStarted(4, { id: "i4", type: "mcpToolCall", server: "other_server", tool: "browser_navigate" }),
        ),
      },
    });

    await page.goto("/");
    await expect(page.locator(".chat")).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(1200);
    await expect(page.locator(".workspace")).toHaveCount(0);
  });

  test("the aio_browser MCP navigate tool leaves the workspace closed", async ({ page }) => {
    await page.bringToFront();
    await mockConsole(page, {
      conversations,
      sse: {
        [CONV_ID]: sse(
          replayComplete(0),
          itemStarted(1, { id: "i1", type: "mcpToolCall", server: "aio_browser", tool: "browser_navigate" }),
        ),
      },
    });

    await page.goto("/");
    await expect(page.locator(".chat")).toBeVisible();
    await expect(page.locator(".working")).toBeVisible();
    await expect(page.locator(".workspace")).toHaveCount(0);
  });

  test("a background/unfocused page does not steal focus", async ({ page }) => {
    // Simulate the tab being in the background: a live navigation must not yank
    // the workspace open while the user is looking at something else.
    await page.addInitScript(() => {
      Document.prototype.hasFocus = () => false;
    });
    await mockConsole(page, {
      conversations,
      sse: {
        [CONV_ID]: sse(
          replayComplete(0),
          itemStarted(1, { id: "i1", type: "commandExecution", command: "aio browser navigate https://example.com" }),
        ),
      },
    });

    await page.goto("/");
    await expect(page.locator(".chat")).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(800);
    await expect(page.locator(".workspace")).toHaveCount(0);
  });
});

test('main inbox and task details stay put during browser navigation; workspace opens manually', async ({page}, info) => {
  const item={id:'main-nav',type:'mcpToolCall',server:'aio_browser',tool:'browser_navigate'};
  await mockConsole(page,{conversations,sse:{[CONV_ID]:sse(replayComplete(0),itemStarted(1,item),`id: 2\nevent: turn.finished\ndata: ${JSON.stringify({id:2,type:'turn.finished',turnId:'t1',createdAt:Date.now(),payload:{status:'completed'}})}\n\n`)}});
  const task={id:'task-nav',revision:1,title:'浏览网页',text:'查一下',conversationId:CONV_ID,status:'running',result:null,error:null,attachments:[],relatedTaskId:null,dependencies:[],approvals:0,createdAt:Date.now(),completedAt:null};
  let reads=0;
  await page.route('**/api/main*',route=>{reads++;return route.fulfill({json:{mode:'tasks',tasks:[task],nextBefore:null}});});
  await page.goto('/');await expect(page.getByRole('heading',{name:'主会话',exact:true})).toBeVisible();
  await expect.poll(()=>reads).toBeGreaterThan(1);
  await expect(page.locator('.workspace')).toHaveCount(0);
  await page.getByRole('button',{name:'展开任务：浏览网页',exact:true}).click();
  await expect(page.locator('.task-detail .working')).toBeVisible();
  await expect(page.locator('.workspace')).toHaveCount(0);
  if(info.project.name.startsWith('mobile'))await page.getByRole('button',{name:'打开导航'}).click();
  await page.locator('.sidebar').getByRole('button',{name:'工作区',exact:true}).click();
  await expect(page.locator('.workspace')).toBeVisible();
});
