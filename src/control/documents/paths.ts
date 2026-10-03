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

export type DocumentKind = "image" | "video" | "audio" | "pdf" | "word" | "excel" | "ppt" | "text" | "unsupported";

/**
 * Extension classification. Raster images are streamed as-is; pdf/word/excel/ppt
 * are rendered to page rasters inside the sandbox; text is shown escaped with a
 * size cap. Everything else is download-only — never guessed as renderable.
 *
 * HTML is deliberately `text`: it is displayed escaped, never parsed as markup, so
 * agent-produced active content cannot execute in the console. SVG is an `image`:
 * it is only ever drawn by an <img> (and served under a sandboxing CSP), where its
 * scripts never run and it loads nothing.
 */
const KIND_BY_EXTENSION: Record<string, DocumentKind> = {
  mp4: "video",
  m4v: "video",
  mov: "video",
  webm: "video",
  mp3: "audio",
  m4a: "audio",
  aac: "audio",
  wav: "audio",
  ogg: "audio",
  oga: "audio",
  opus: "audio",
  flac: "audio",
  png: "image",
  jpg: "image",
  jpeg: "image",
  webp: "image",
  gif: "image",
  avif: "image",
  bmp: "image",
  svg: "image",
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

/** The content type a media file is served with, by extension. */
const MEDIA_TYPES: Record<string, string> = {
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm",
  mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav",
  ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", flac: "audio/flac",
};

export function mediaType(path: string): string | null {
  return MEDIA_TYPES[extensionOf(path)] ?? null;
}

/**
 * Whether a file's first bytes are the format its extension claims, so a file
 * renamed to .mp3 is never served to a media element as audio.
 */
export function mediaSignatureMatches(path: string, head: Uint8Array): boolean {
  const ascii = (from: number, to: number) => String.fromCharCode(...head.subarray(from, to));
  const box = head.length >= 8 ? ascii(4, 8) : "";
  const id3 = head.length >= 3 && ascii(0, 3) === "ID3";
  const sync = head.length >= 2 && head[0] === 0xff && (head[1]! & 0xe0) === 0xe0;
  switch (extensionOf(path)) {
    case "mp4": case "m4v": case "m4a": return box === "ftyp";
    // QuickTime files from older cameras start with the movie or data atom instead.
    case "mov": return ["ftyp", "moov", "mdat", "free", "wide", "skip"].includes(box);
    case "webm": return head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
    case "mp3": return id3 || sync;
    case "aac": return id3 || (head.length >= 2 && head[0] === 0xff && (head[1]! & 0xf6) === 0xf0) || (head.length >= 4 && ascii(0, 4) === "ADIF");
    case "wav": return head.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE";
    case "ogg": case "oga": case "opus": return head.length >= 4 && ascii(0, 4) === "OggS";
    case "flac": return id3 || (head.length >= 4 && ascii(0, 4) === "fLaC");
    default: return false;
  }
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
