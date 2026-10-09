import { parseForm, type FormSpec } from "../../common/form";

/**
 * Tappable answers in a message. An executor that needs the person to pick one
 * of a few answers ends its reply with the question and a block:
 *
 *   ```choices
 *   ["Enfamil（美赞臣）", "Similac（雅培）", "两个都比一下"]
 *   ```
 *
 * (a JSON list, or one answer per line). Tapping one sends it back as the reply.
 * A block that does not hold 2–6 short answers stays an ordinary code block.
 */
export type ChoicePart = { kind: "text"; text: string } | { kind: "choices"; options: string[] };

const FENCE = /^```choices[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;
const MAX_OPTION_CHARS = 60;

export function parseChoices(body: string): string[] | null {
  let items: unknown[];
  try {
    const parsed: unknown = JSON.parse(body);
    if (!Array.isArray(parsed)) return null;
    items = parsed;
  } catch {
    items = body.split("\n").map((line) => line.replace(/^\s*(?:[-*•]|\d+[.、)])\s*/, ""));
  }
  const seen = new Set<string>();
  const options: string[] = [];
  for (const item of items) {
    if (typeof item !== "string") return null;
    const text = item.replace(/\s+/g, " ").trim();
    if (!text) continue;
    if ([...text].length > MAX_OPTION_CHARS) return null;
    if (!seen.has(text)) options.push(text);
    seen.add(text);
  }
  return options.length >= 2 && options.length <= 6 ? options : null;
}

/** Split text into prose and answer lists, in order. */
export function splitChoiceBlocks(source: string): ChoicePart[] {
  const parts: ChoicePart[] = [];
  let last = 0;
  for (const match of source.matchAll(FENCE)) {
    const options = parseChoices(match[1]!);
    if (!options) continue;
    if (match.index! > last) parts.push({ kind: "text", text: source.slice(last, match.index) });
    parts.push({ kind: "choices", options });
    last = match.index! + match[0].length;
  }
  if (parts.length === 0) return [{ kind: "text", text: source }];
  if (last < source.length) parts.push({ kind: "text", text: source.slice(last) });
  return parts.filter((p) => p.kind === "choices" || p.text.trim() !== "");
}

/**
 * The question an executor ends on when it cannot go on without the person
 * (```ask_user with {"question": "...", "options": [...]}). The task card asks it;
 * in the conversation it reads as the question it is, not as raw JSON.
 */
export type AskPart = { kind: "text"; text: string } | { kind: "ask"; question: string; options: string[] | null; form: FormSpec | null };

const ASK_FENCE = /^```ask_user[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;

export function splitAskBlocks(source: string): AskPart[] {
  const parts: AskPart[] = [];
  let last = 0;
  for (const match of source.matchAll(ASK_FENCE)) {
    let value: { question?: unknown; options?: unknown; fields?: unknown; title?: unknown; submit?: unknown };
    try { value = JSON.parse(match[1]!) as typeof value; } catch { continue; }
    const question = typeof value.question === "string" ? value.question.trim() : "";
    if (!question) continue;
    const options = Array.isArray(value.options) ? parseChoices(JSON.stringify(value.options)) : null;
    if (match.index! > last) parts.push({ kind: "text", text: source.slice(last, match.index) });
    const form = value.fields !== undefined ? parseForm({ title: value.title, fields: value.fields, submit: value.submit }) : null;
    parts.push({ kind: "ask", question, options: form ? null : options, form });
    last = match.index! + match[0].length;
  }
  if (parts.length === 0) return [{ kind: "text", text: source }];
  if (last < source.length) parts.push({ kind: "text", text: source.slice(last) });
  return parts.filter((p) => p.kind === "ask" || p.text.trim() !== "");
}

/** A ```form block: fields the person fills in and sends as one reply (see common/form). */
export type FormPart = { kind: "text"; text: string } | { kind: "form"; spec: FormSpec };

const FORM_FENCE = /^```form[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;

export function splitFormBlocks(source: string): FormPart[] {
  const parts: FormPart[] = [];
  let last = 0;
  for (const match of source.matchAll(FORM_FENCE)) {
    let spec: FormSpec | null = null;
    try { spec = parseForm(JSON.parse(match[1]!)); } catch { spec = null; }
    if (!spec) continue;
    if (match.index! > last) parts.push({ kind: "text", text: source.slice(last, match.index) });
    parts.push({ kind: "form", spec });
    last = match.index! + match[0].length;
  }
  if (parts.length === 0) return [{ kind: "text", text: source }];
  if (last < source.length) parts.push({ kind: "text", text: source.slice(last) });
  return parts.filter((p) => p.kind === "form" || p.text.trim() !== "");
}
