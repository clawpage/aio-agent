import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { LastPages } from "../../src/control/browser/lastPages.js";

const dirs: string[] = [];
const store = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "last-pages-")); dirs.push(dir); return { dir, pages: new LastPages(dir) }; };
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

it("keeps a task's last web page and its picture, and only web pages", () => {
  const { pages } = store();
  pages.save("conv_a", { url: "https://www.amazon.com/checkout", title: "Checkout" }, Buffer.from("jpg"));
  expect(pages.get("conv_a")).toMatchObject({ url: "https://www.amazon.com/checkout", title: "Checkout", shot: true });
  expect(pages.shot("conv_a")?.toString()).toBe("jpg");
  // A blank or browser-internal page leaves the last real one in place.
  pages.save("conv_a", { url: "about:blank", title: "" }, Buffer.from("blank"));
  pages.save("conv_a", { url: "chrome-error://chromewebdata/", title: "" }, null);
  expect(pages.get("conv_a")?.url).toBe("https://www.amazon.com/checkout");
  expect(pages.shot("conv_a")?.toString()).toBe("jpg");
  // A key that could leave the directory is refused.
  pages.save("../x", { url: "https://a.example/", title: "" }, null);
  expect(pages.get("../x")).toBeNull();
});

it("drops a stale picture when the page moved on without a new one", () => {
  const { pages } = store();
  pages.save("conv_b", { url: "https://a.example/1", title: "1" }, Buffer.from("one"));
  pages.save("conv_b", { url: "https://a.example/1", title: "1" }, null);
  expect(pages.get("conv_b")?.shot).toBe(true);
  pages.save("conv_b", { url: "https://a.example/2", title: "2" }, null);
  expect(pages.get("conv_b")).toMatchObject({ url: "https://a.example/2", shot: false });
  expect(pages.shot("conv_b")).toBeNull();
});
