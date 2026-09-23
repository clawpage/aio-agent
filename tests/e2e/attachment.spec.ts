import { expect, test, type Page } from "@playwright/test";

/**
 * Attachment flow: the 附件 control must open the native file chooser (a real
 * <label> wrapping a visually-hidden input, not a display:none input driven by a
 * programmatic click), upload a file, and show a visible chip. Runs on desktop
 * and mobile projects.
 *
 * Only tiny synthetic files are uploaded. Every test records the exact
 * conversation ids and sandbox paths it created and removes them in `finally`,
 * so a failed assertion never leaves synthetic uploads or empty conversations
 * behind (including against a real deployment). Cleanup asserts success.
 */

async function ensureApp(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator(".app")).toBeVisible({ timeout: 60_000 });
}

/** Origin + double-submit CSRF token for authenticated state-changing requests. */
async function authHeaders(page: Page): Promise<Record<string, string>> {
  const cookies = await page.context().cookies();
  const csrf = cookies.find((c) => c.name === "pa_csrf")?.value ?? "";
  return {
    // `guardUnsafe` rejects unsafe requests without an Origin, and the
    // control-plane origin requires the session-bound CSRF token.
    origin: new URL(page.url()).origin,
    "x-csrf-token": csrf,
  };
}

/** Delete an uploaded sandbox file through the authenticated API. */
async function deleteUploaded(page: Page, path: string): Promise<void> {
  const res = await page.request.post("/api/files/delete", {
    headers: await authHeaders(page),
    data: { path },
  });
  expect(res.ok(), `deleting synthetic upload ${path} must succeed (HTTP ${res.status()})`).toBe(true);
}

/** Archive a conversation created by this test; never touches the owner's own. */
async function archiveConversation(page: Page, id: string): Promise<void> {
  const res = await page.request.patch(`/api/conversations/${encodeURIComponent(id)}`, {
    headers: await authHeaders(page),
    data: { archived: true },
  });
  expect(res.ok(), `archiving test conversation ${id} must succeed (HTTP ${res.status()})`).toBe(true);
}

/**
 * Create a new empty conversation and record its id in `created` *before* any
 * later assertion can fail, so the caller's `finally` always archives it.
 */
async function newConversation(page: Page, created: string[]): Promise<string> {
  await ensureApp(page);
  const createResponse = page.waitForResponse(
    (r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/conversations",
  );
  const bottomNav = page.locator(".bottom-nav button", { hasText: "新建" });
  if (await bottomNav.isVisible().catch(() => false)) await bottomNav.click();
  else await page.getByRole("button", { name: "＋ 新建会话" }).click();
  const res = await createResponse;
  const body = (await res.json().catch(() => ({}))) as { conversation?: { id?: string } };
  const id = body.conversation?.id;
  if (typeof id === "string") created.push(id);
  expect(res.status(), "creating a test conversation must succeed").toBe(201);
  expect(typeof id, "create response must include a conversation id").toBe("string");
  await expect(page.locator(".composer textarea")).toBeVisible({ timeout: 20_000 });
  return id as string;
}

/**
 * Remove every synthetic artifact this test created. Runs each step even if an
 * earlier one fails, then surfaces the first error so leaks are never silent.
 */
async function cleanup(page: Page, uploaded: string[], created: string[]): Promise<void> {
  const errors: unknown[] = [];
  for (const path of uploaded) {
    try {
      await deleteUploaded(page, path);
    } catch (err) {
      errors.push(err);
    }
  }
  for (const id of created) {
    try {
      await archiveConversation(page, id);
    } catch (err) {
      errors.push(err);
    }
  }
  if (errors.length > 0) throw errors[0];
}

test.describe("attachment upload", () => {
  test("附件 opens a real file chooser and uploads a synthetic file to a visible chip", async ({ page }) => {
    const created: string[] = [];
    const uploaded: string[] = [];
    try {
      await newConversation(page, created);

      const input = page.getByTestId("attachment-input");
      await expect(input).toBeAttached();

      // The label must open the native picker (this is the behavior that was
      // reported as a no-op).
      const chooserPromise = page.waitForEvent("filechooser");
      await page.locator(".file-button").click();
      const chooser = await chooserPromise;

      const uploadPromise = page.waitForResponse((r) => r.url().includes("/api/sandbox/upload"));
      await chooser.setFiles({
        name: "pa-e2e-synthetic.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("personal-agent e2e synthetic attachment\n"),
      });
      const upload = await uploadPromise;
      const body = (await upload.json().catch(() => ({}))) as { path?: string; kind?: string };
      if (typeof body.path === "string") uploaded.push(body.path);
      expect(upload.status()).toBe(200);
      expect(typeof body.path, "upload response must include a sandbox path").toBe("string");

      // A visible chip appears with the file name, and the send button is enabled.
      await expect(page.locator(".composer .chip", { hasText: "pa-e2e-synthetic.txt" })).toBeVisible({ timeout: 20_000 });
      await expect(page.getByRole("button", { name: /发送/ })).toBeEnabled();

      // The chip can be removed before sending.
      await page.locator(".composer .chip", { hasText: "pa-e2e-synthetic.txt" }).getByRole("button", { name: "移除附件" }).click();
      await expect(page.locator(".composer .chip", { hasText: "pa-e2e-synthetic.txt" })).toHaveCount(0);
    } finally {
      // The chip was removed, but the file still exists in the sandbox.
      await cleanup(page, uploaded, created);
    }
  });

  test("attachment control stays focusable and is disabled while a send is in flight", async ({ page }) => {
    const created: string[] = [];
    try {
      await newConversation(page, created);
      const input = page.getByTestId("attachment-input");

      // Visually hidden but still a real focusable control (never display:none), so
      // keyboard users can reach it.
      await input.focus();
      await expect(input).toBeFocused();

      // Hold the submit request open so the composer is busy, then verify the file
      // control is disabled: uploading now would race the composer being cleared
      // on send.
      await page.route("**/api/conversations/*/turns", async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await route.abort();
      });
      await page.locator(".composer textarea").fill("busy-send");
      await page.getByRole("button", { name: "发送" }).click();
      await expect(input).toBeDisabled();
      await expect(page.locator(".file-button")).toHaveClass(/disabled/);

      // After the send settles the control is usable again and the draft survived
      // the failed request so it can be retried safely.
      await expect(input).toBeEnabled({ timeout: 20_000 });
      await expect(page.locator(".composer textarea")).toHaveValue("busy-send");
    } finally {
      await cleanup(page, [], created);
    }
  });

  test("uploads a small synthetic image and classifies it as an image chip", async ({ page }) => {
    const created: string[] = [];
    const uploaded: string[] = [];
    try {
      await newConversation(page, created);
      const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082", "hex");

      const uploadPromise = page.waitForResponse((r) => r.url().includes("/api/sandbox/upload"));
      await page.getByTestId("attachment-input").setInputFiles({
        name: "pa-e2e-pixel.png",
        mimeType: "image/png",
        buffer: png,
      });
      const upload = await uploadPromise;
      const body = (await upload.json().catch(() => ({}))) as { path?: string; kind?: string };
      if (typeof body.path === "string") uploaded.push(body.path);
      expect(upload.status()).toBe(200);
      expect(typeof body.path, "upload response must include a sandbox path").toBe("string");
      expect(body.kind).toBe("image");

      const chip = page.locator(".composer .chip", { hasText: "pa-e2e-pixel.png" });
      await expect(chip).toBeVisible({ timeout: 20_000 });
      await expect(chip).toContainText("🖼");
    } finally {
      await cleanup(page, uploaded, created);
    }
  });
});
