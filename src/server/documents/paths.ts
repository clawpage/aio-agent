/**
 * Path and format classification for the sandbox document tools.
 *
 * Every path that reaches a container command is validated here first. The
 * control plane must never hand an arbitrary path to LibreOffice/poppler, and a
 * crafted filename must never add an extra argv element. Commands therefore
 * receive only absolute container paths (an absolute path can never be read as
 * an option) built from a fixed program/argv shape, and a leading `-` segment is
 * rejected anyway as defence in depth.
 *
 * This is the *first* of two checks: the render path additionally resolves the
 * real path inside the container, so a symlink pointing outside the workspace is
 * rejected even though the lexical path looked valid.
 */

export type DocumentKind = "image" | "pdf" | "word" | "excel" | "ppt" | "text" | "unsupported";

/**
 * Extension classification. Raster images are streamed as-is; pdf/word/excel/ppt
 * are rendered to page rasters inside the sandbox; text is shown escaped with a
 * size cap. Everything else is download-only — never guessed as renderable.
 *
 * HTML and SVG are deliberately `text`: they are displayed escaped, never parsed
 * as markup, so agent-produced active content cannot execute in the console.
 */
const KIND_BY_EXTENSION: Record<string, DocumentKind> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  webp: "image",
  gif: "image",
  avif: "image",
  bmp: "image",
  pdf: "pdf",
  doc: "word",
  docx: "word",
  odt: "word",
  rtf: "word",
  xls: "excel",
  xlsx: "excel",
  ods: "excel",
  ppt: "ppt",
  pptx: "ppt",
  odp: "ppt",
  txt: "text",
  md: "text",
  markdown: "text",
  log: "text",
  csv: "text",
  tsv: "text",
  json: "text",
  yml: "text",
  yaml: "text",
  toml: "text",
  ini: "text",
  conf: "text",
  xml: "text",
  html: "text",
  htm: "text",
  svg: "text",
  css: "text",
  js: "text",
  mjs: "text",
  cjs: "text",
  ts: "text",
  tsx: "text",
  jsx: "text",
  py: "text",
  sh: "text",
  sql: "text",
  diff: "text",
  patch: "text",
};

/** Kinds the sandbox tools can turn into page rasters. */
const RENDERABLE = new Set<DocumentKind>(["image", "pdf", "word", "excel", "ppt"]);

export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : "";
}

export function documentKind(path: string): DocumentKind {
  return KIND_BY_EXTENSION[extensionOf(path)] ?? "unsupported";
}

export function isRenderableKind(kind: DocumentKind): boolean {
  return RENDERABLE.has(kind);
}

/** Single-quote a value for a shell that we only ever feed constant scripts. */
export function quoteArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Validate that `input` is an absolute file path inside `workspaceRoot`.
 *
 * Traversal is normalised away *before* the root check, so
 * `/home/gem/workspace/../etc/passwd` collapses to `/home/gem/etc/passwd` and is
 * rejected. Control characters, backslashes and `-`-leading segments are refused
 * outright.
 */
export function requireWorkspaceFilePath(
  input: string,
  workspaceRoot: string,
): { ok: true; path: string } | { ok: false; message: string } {
  const value = typeof input === "string" ? input : "";
  if (!value) return { ok: false, message: "缺少路径" };
  if (value.length > 4096) return { ok: false, message: "路径过长" };
  if (!value.startsWith("/")) return { ok: false, message: "路径必须是沙箱内的绝对路径" };
  if (value.startsWith("//")) return { ok: false, message: "路径格式非法" };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return { ok: false, message: "路径包含非法控制字符" };
  if (value.includes("\\")) return { ok: false, message: "路径不能包含反斜杠" };

  const root = workspaceRoot.replace(/\/+$/, "");
  const parts: string[] = [];
  for (const segment of value.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      parts.pop();
      continue;
    }
    if (segment.startsWith("-")) return { ok: false, message: "路径片段不能以 - 开头" };
    parts.push(segment);
  }
  const normalized = `/${parts.join("/")}`;
  if (normalized !== root && !normalized.startsWith(`${root}/`)) {
    return { ok: false, message: "只允许访问沙箱工作区内的文件" };
  }
  if (normalized === root) return { ok: false, message: "需要一个文件路径，而不是工作区根目录" };
  return { ok: true, path: normalized };
}

/** True when `resolved` is still inside the workspace root (second-layer check). */
export function isInsideWorkspace(resolved: string, workspaceRoot: string): boolean {
  const root = workspaceRoot.replace(/\/+$/, "");
  return resolved === root || resolved.startsWith(`${root}/`);
}

/**
 * A user-supplied *relative* name for a new file (document tool output). Kept
 * deliberately narrow: no separators, no traversal, no leading dot or dash.
 */
export function isSafeBaseName(name: string): boolean {
  if (!name || name.length > 120) return false;
  if (name.startsWith(".") || name.startsWith("-")) return false;
  if (/[\u0000-\u001f\u007f]/.test(name)) return false;
  if (name.includes("/") || name.includes("\\")) return false;
  return true;
}

/** Split a validated absolute path into directory + base name. */
export function splitPath(path: string): { dir: string; base: string } {
  const idx = path.lastIndexOf("/");
  return { dir: idx <= 0 ? "/" : path.slice(0, idx), base: path.slice(idx + 1) };
}

/** Swap the extension of a base name, keeping the stem (used for new outputs). */
export function withExtension(base: string, extension: string): string {
  const stem = base.includes(".") ? base.slice(0, base.lastIndexOf(".")) : base;
  return `${stem || "document"}.${extension}`;
}
