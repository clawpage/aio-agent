import fs from "node:fs";
import path from "node:path";

/** The page a task's browser last showed: where it was, what it was called, and when. */
export interface LastPage {
  url: string;
  title: string;
  at: number;
  /** Whether a picture of it was kept too. */
  shot: boolean;
}

const KEY = /^[A-Za-z0-9_-]{1,80}$/;
/** Past this many tasks the oldest pages are forgotten. */
const KEEP = 300;

/**
 * What each task's browser last showed, kept in the account's data directory after
 * the sandbox has closed the tab (finished tabs go after a few minutes): the task's
 * card can still show the page and offer to open it again. Only web pages are kept.
 */
export class LastPages {
  #dir: string;

  constructor(dataDir: string) {
    this.#dir = path.join(dataDir, "task-pages");
  }

  save(key: string, page: { url: string; title: string }, shot: Buffer | null): void {
    if (!KEY.test(key) || !/^https?:\/\//i.test(page.url)) return;
    try {
      fs.mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
      if (shot) fs.writeFileSync(path.join(this.#dir, `${key}.jpg`), shot, { mode: 0o600 });
      // A page seen again without a new picture keeps the last one only if it is the same page.
      const before = this.get(key);
      const keepShot = !shot && before?.shot && before.url === page.url;
      if (!shot && !keepShot) fs.rmSync(path.join(this.#dir, `${key}.jpg`), { force: true });
      const record: LastPage = { url: page.url, title: page.title.slice(0, 300), at: Date.now(), shot: Boolean(shot) || Boolean(keepShot) };
      fs.writeFileSync(path.join(this.#dir, `${key}.json`), JSON.stringify(record), { mode: 0o600 });
      this.#trim();
    } catch {
      // Only a convenience: a page not kept is a card without the reopen entry.
    }
  }

  get(key: string): LastPage | null {
    if (!KEY.test(key)) return null;
    try {
      const record = JSON.parse(fs.readFileSync(path.join(this.#dir, `${key}.json`), "utf8")) as LastPage;
      return typeof record.url === "string" && /^https?:\/\//i.test(record.url) ? record : null;
    } catch {
      return null;
    }
  }

  shot(key: string): Buffer | null {
    if (!KEY.test(key)) return null;
    try {
      return fs.readFileSync(path.join(this.#dir, `${key}.jpg`));
    } catch {
      return null;
    }
  }

  #trim(): void {
    const records = fs.readdirSync(this.#dir).filter((f) => f.endsWith(".json"));
    if (records.length <= KEEP) return;
    const aged = records.map((f) => ({ f, at: fs.statSync(path.join(this.#dir, f)).mtimeMs })).sort((a, b) => a.at - b.at);
    for (const { f } of aged.slice(0, records.length - KEEP)) {
      const key = f.slice(0, -5);
      fs.rmSync(path.join(this.#dir, `${key}.json`), { force: true });
      fs.rmSync(path.join(this.#dir, `${key}.jpg`), { force: true });
    }
  }
}
