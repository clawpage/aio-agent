/**
 * A form an executor asks the person to fill in: several answers in one go
 * (dates, numbers, a pick from a list, notes), where a single question or a
 * row of choices is not enough. It is written as JSON, in a ```form block or
 * in an ask_user block's "fields":
 *
 *   {"title": "订位信息", "fields": [
 *     {"name": "date", "label": "日期", "type": "date", "required": true},
 *     {"name": "people", "label": "人数", "type": "number", "min": 1, "max": 20, "default": 2},
 *     {"name": "area", "label": "区域", "type": "select", "options": ["圣何塞", "旧金山"]},
 *     {"name": "taste", "label": "口味", "type": "checkbox", "options": ["川菜", "粤菜"]},
 *     {"name": "note", "label": "备注", "type": "textarea", "placeholder": "忌口等"}
 *   ], "submit": "提交"}
 *
 * Submitting sends the answers back as one plain message ("日期：2026-10-12", one
 * per line), so the reply reads like anything else the person wrote. A block
 * that does not hold a usable form stays an ordinary code block.
 * Browser-safe: no Node APIs (the console imports it).
 */
export const FORM_FIELD_TYPES = ["text", "textarea", "number", "date", "time", "select", "radio", "checkbox"] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

export interface FormField {
  name: string;
  label: string;
  type: FormFieldType;
  required: boolean;
  options?: string[];
  placeholder?: string;
  default?: string | string[];
  min?: number;
  max?: number;
}

export interface FormSpec {
  title: string | null;
  fields: FormField[];
  submit: string;
}

export const MAX_FORM_FIELDS = 8;
const MAX_LABEL = 30;
const MAX_OPTION = 40;
const MAX_OPTIONS = 10;
const CHOOSING = new Set<FormFieldType>(["select", "radio", "checkbox"]);

const short = (value: unknown, max: number): string | null => {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text && [...text].length <= max ? text : null;
};

/** A usable form from parsed JSON, or null. Unknown keys are ignored; anything malformed rejects the whole form. */
export function parseForm(value: unknown): FormSpec | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as { title?: unknown; fields?: unknown; submit?: unknown };
  if (!Array.isArray(raw.fields) || raw.fields.length < 1 || raw.fields.length > MAX_FORM_FIELDS) return null;
  const fields: FormField[] = [];
  const names = new Set<string>();
  for (const item of raw.fields) {
    if (!item || typeof item !== "object") return null;
    const f = item as Record<string, unknown>;
    const label = short(f.label, MAX_LABEL);
    const type = (typeof f.type === "string" ? f.type : "text") as FormFieldType;
    if (!label || !FORM_FIELD_TYPES.includes(type)) return null;
    const name = (typeof f.name === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(f.name) ? f.name : `f${fields.length + 1}`);
    if (names.has(name)) return null;
    names.add(name);
    const field: FormField = { name, label, type, required: f.required === true };
    if (CHOOSING.has(type)) {
      if (!Array.isArray(f.options)) return null;
      const options = [...new Set(f.options.map((o) => short(o, MAX_OPTION)))];
      if (options.some((o) => o === null) || options.length < 2 || options.length > MAX_OPTIONS) return null;
      field.options = options as string[];
    }
    const placeholder = short(f.placeholder, 60);
    if (placeholder) field.placeholder = placeholder;
    if (type === "number") {
      if (typeof f.min === "number" && Number.isFinite(f.min)) field.min = f.min;
      if (typeof f.max === "number" && Number.isFinite(f.max)) field.max = f.max;
    }
    if (type === "checkbox" && Array.isArray(f.default)) {
      const picked = f.default.filter((d): d is string => typeof d === "string" && !!field.options?.includes(d));
      if (picked.length) field.default = picked;
    } else if (typeof f.default === "string" || typeof f.default === "number") {
      const d = String(f.default);
      if (!field.options || field.options.includes(d)) field.default = d;
    }
    fields.push(field);
  }
  return { title: short(raw.title, 40), fields, submit: short(raw.submit, 12) ?? "提交" };
}

/** The answers as the message the person sends: one "label：value" line per answered field. */
export function formAnswerText(spec: FormSpec, values: Record<string, string | string[]>): string {
  const lines: string[] = [];
  for (const field of spec.fields) {
    const value = values[field.name];
    const text = Array.isArray(value) ? value.join("、") : (value ?? "").trim();
    if (text) lines.push(`${field.label}：${text}`);
  }
  return lines.join("\n");
}

/** Fields the person must still fill in before the form can be sent. */
export function missingFields(spec: FormSpec, values: Record<string, string | string[]>): string[] {
  return spec.fields.filter((f) => {
    if (!f.required) return false;
    const value = values[f.name];
    return Array.isArray(value) ? value.length === 0 : !(value ?? "").trim();
  }).map((f) => f.label);
}
