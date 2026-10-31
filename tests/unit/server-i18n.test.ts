import { expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import os from "node:os";
import { MESSAGES, currentLocale, requestLocale, runInLocale, runInLocaleOr, t } from "../../src/control/i18n/index.js";
import { getMeta, openDb } from "../../src/control/db.js";
import { readLocale } from "../../src/control/locale.js";

/**
 * The control plane, the sandbox node and the scripts they put in the sandbox
 * write for people only through src/control/i18n/locales (in every console
 * language); what only a model or a log reads is in English. Chinese that
 * matches data rather than showing it (a person's words, an older prompt)
 * stays in code: regex literals are allowed, and any other such line carries
 * an `i18n-exempt: <reason>` comment.
 */
const ROOT = path.resolve(import.meta.dirname, "..", "..", "src");
const DIRS = ["control", "sandbox", "common"].map((d) => path.join(ROOT, d));
const LOCALE_DIR = path.join(ROOT, "control", "i18n", "locales");
const CJK = /[　-〿一-鿿＀-￯]/;

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return full === LOCALE_DIR ? [] : files(full);
    return /\.(ts|cjs|mjs|js|py|sh)$/.test(e.name) ? [full] : [];
  });
}

function problems(file: string): string[] {
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split("\n");
  const exempt = (line: number) => lines[line]?.includes("i18n-exempt:");
  const at = (line: number, what: string) => `${path.relative(ROOT, file)}:${line + 1} ${what.trim().slice(0, 50)}`;
  if (/\.(py|sh)$/.test(file)) {
    // Comments may be in any language; a line that prints or returns words may not.
    return lines.flatMap((l, i) => (CJK.test(l.replace(/(^|\s)#.*$/, "")) && !exempt(i) ? [at(i, l)] : []));
  }
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      const line = source.getLineAndCharacterOfPosition(node.getStart()).line;
      if (CJK.test(node.text) && !exempt(line)) found.push(at(line, node.text));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

it("keeps every word the server writes for people in the locale files", () => {
  expect(DIRS.flatMap(files).flatMap(problems)).toEqual([]);
});

it("gives every language every message", () => {
  const shape = (value: unknown): unknown =>
    typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v)])) : typeof value;
  const [reference, ...others] = Object.values(MESSAGES);
  for (const messages of others) expect(shape(messages)).toEqual(shape(reference));
});

it("answers in the console's language, else the browser's, else English", () => {
  expect(requestLocale({ "x-aio-locale": "es", "accept-language": "zh-CN" })).toBe("es");
  expect(requestLocale({ "x-aio-locale": "fr", "accept-language": "fr-FR, zh-HK;q=0.8, en;q=0.9" })).toBe("en");
  expect(requestLocale({ "accept-language": "fr-FR, zh-HK;q=0.9, en;q=0.8" })).toBe("zh-TW");
  expect(requestLocale({ "accept-language": "de, fr" })).toBe("en");
  expect(requestLocale({})).toBe("en");
  expect(t()).toBe(MESSAGES.en);
  expect(runInLocale("zh-TW", () => t())).toBe(MESSAGES["zh-TW"]);
});

/** A task row as an older account has them (only the columns a row needs). */
function addTask(db: ReturnType<typeof openDb>): void {
  db.exec("PRAGMA foreign_keys=OFF");
  db.prepare("INSERT INTO tasks (id,client_message_id,conversation_id,title,input_text,created_at) VALUES ('t1','m1','c1','hi','hi',1)").run();
}

it("work started from a timer is written in the account's language; a request keeps its own", async () => {
  // A timer callback carries no language: without the fallback it would fall to English.
  const fromTimer = await new Promise<string>((resolve) => setTimeout(() => resolve(runInLocaleOr(() => "zh-CN", () => currentLocale())), 0));
  expect(fromTimer).toBe("zh-CN");
  expect(runInLocale("es", () => runInLocaleOr(() => "zh-CN", () => currentLocale()))).toBe("es");
});

it("keeps Simplified Chinese for accounts that had tasks before English became the default, once", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pa-locale-"));
  const file = path.join(dir, "old.sqlite");
  const old = openDb(file);
  expect(readLocale(old)).toBe("en");
  old.prepare("DELETE FROM meta WHERE key='account.locale.legacy_checked'").run();
  addTask(old);
  old.close();
  expect(readLocale(openDb(file))).toBe("zh-CN");
  // A newer account with tasks but no language yet is not assigned it on a later start.
  const fresh = openDb(path.join(dir, "new.sqlite"));
  expect(getMeta(fresh, "account.locale.legacy_checked")).toBe("1");
  addTask(fresh);
  fresh.close();
  expect(readLocale(openDb(path.join(dir, "new.sqlite")))).toBe("en");
});
