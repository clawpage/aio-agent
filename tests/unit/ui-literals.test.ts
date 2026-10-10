import { expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { LOCALES } from "../../src/ui/src/i18n";

/**
 * The console's words and colors each live in one place: copy in
 * src/ui/src/i18n/locales, colors in src/ui/src/theme.css. Components refer to
 * them by name, so a language or a palette is changed in one file.
 *
 * Chinese that parses data rather than showing it (a regular expression, a
 * token the server matches) stays in code: regex literals are allowed, and any
 * other such line carries an `// i18n-exempt: <reason>` comment.
 */
const UI = path.resolve(import.meta.dirname, "..", "..", "src", "ui", "src");
const LOCALE_DIR = path.join(UI, "i18n", "locales");
const THEME = path.join(UI, "theme.css");
// Chinese text and its full-width punctuation; the full-width ＋ and － are symbols, not words.
const CJK = /(?![＋－])[　-〿一-鿿＀-￯]/;
const COLOR = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;

function files(dir: string, ext: RegExp): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return full === LOCALE_DIR ? [] : files(full, ext);
    return ext.test(e.name) ? [full] : [];
  });
}

/** Every string, template piece and JSX text in a source file, with its line. */
function literals(file: string): { text: string; line: number }[] {
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: { text: string; line: number }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node)) {
      found.push({ text: node.text, line: source.getLineAndCharacterOfPosition(node.getStart()).line });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function exempt(file: string): Set<number> {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  return new Set(lines.flatMap((l, i) => (l.includes("i18n-exempt:") ? [i] : [])));
}

it("keeps every word the console shows in the locale files", () => {
  const problems: string[] = [];
  for (const file of files(UI, /\.tsx?$/)) {
    const allowed = exempt(file);
    for (const { text, line } of literals(file)) {
      if (CJK.test(text) && !allowed.has(line)) problems.push(`${path.relative(UI, file)}:${line + 1} ${text.trim().slice(0, 40)}`);
    }
  }
  expect(problems).toEqual([]);
});

it("keeps every color in theme.css", () => {
  const problems: string[] = [];
  for (const file of files(UI, /\.tsx?$/)) {
    for (const { text, line } of literals(file)) {
      if (COLOR.test(text)) problems.push(`${path.relative(UI, file)}:${line + 1} ${text.trim().slice(0, 40)}`);
    }
  }
  for (const file of files(UI, /\.css$/)) {
    if (file === THEME) continue;
    const css = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
    css.split("\n").forEach((l, i) => {
      // A mask's black is opacity, not a color.
      if (COLOR.test(l) && !/mask-image/.test(l)) problems.push(`${path.relative(UI, file)}:${i + 1} ${l.trim().slice(0, 60)}`);
    });
  }
  expect(problems).toEqual([]);
});

it("gives every language every message", () => {
  const shape = (value: unknown): unknown =>
    typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v)])) : typeof value;
  const [reference, ...others] = Object.values(LOCALES);
  for (const messages of others) expect(shape(messages)).toEqual(shape(reference));
});
