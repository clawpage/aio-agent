/**
 * Link classification for the chat Markdown view.
 *
 * Two kinds of href are meaningful:
 *
 *  - An absolute http/https URL is the only kind of link the console hands to
 *    the sandbox browser.
 *  - An absolute path inside the sandbox workspace (`/home/gem/workspace/...`)
 *    is a file the agent produced; it is previewed (raster images) or downloaded
 *    through the authenticated control-plane API.
 *
 * Everything else (a relative path, a fragment, a protocol-relative `//host`, an
 * empty href, `mailto:`, `javascript:`, `data:`, `file:`, or an absolute path
 * outside the workspace) is never navigable. Those hrefs must never be resolved
 * against the control-plane origin and then opened as if they were real web
 * links. Path classification is only a client-side convenience; the download
 * endpoint re-validates every path server-side.
 */

/** Fixed workspace root inside the AIO sandbox (matches `sandbox.containerWorkspaceDir`). */
export const SANDBOX_WORKSPACE_ROOT = "/home/gem/workspace";

/** Image extensions that may be shown in the in-conversation lightbox. */
export const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "avif", "bmp"]);

/**
 * How the console should present a workspace file. Mirrors the server-side
 * classification (`src/server/documents/paths.ts`): the server is authoritative
 * and re-validates, this only decides which control to render.
 *
 * `text` uses the size-capped text endpoint. Markdown gets a sanitized reading
 * view; HTML/SVG/code remain escaped source, never active documents.
 */
export type WorkspaceFileKind = "image" | "pdf" | "word" | "excel" | "ppt" | "text" | "unsupported";

const KIND_BY_EXTENSION: Record<string, WorkspaceFileKind> = {
  png: "image", jpg: "image", jpeg: "image", webp: "image", gif: "image", avif: "image", bmp: "image",
  pdf: "pdf",
  doc: "word", docx: "word", odt: "word", rtf: "word",
  xls: "excel", xlsx: "excel", ods: "excel",
  ppt: "ppt", pptx: "ppt", odp: "ppt",
  txt: "text", md: "text", markdown: "text", log: "text", csv: "text", tsv: "text", json: "text",
  yml: "text", yaml: "text", toml: "text", ini: "text", conf: "text", xml: "text",
  html: "text", htm: "text", svg: "text", css: "text",
  js: "text", mjs: "text", cjs: "text", ts: "text", tsx: "text", jsx: "text",
  py: "text", sh: "text", sql: "text", diff: "text", patch: "text",
};

export function isSandboxLink(href: string): boolean {
  if (!href) return false;
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    // A bare/relative reference (e.g. `/foo`, `foo/bar`, `#frag`) has no base
    // here on purpose, so it cannot silently become the current page's origin.
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

/**
 * True for an already-decoded absolute path inside the sandbox workspace.
 *
 * Rejects protocol-relative paths, control characters, backslashes and any `..`
 * segment, so a crafted href can never point at `/etc/...` or escape the
 * workspace through traversal.
 */
export function isWorkspaceFilePath(path: string): boolean {
  if (!path || !path.startsWith("/")) return false;
  if (path.startsWith("//")) return false;
  if (path.includes("\u0000") || path.includes("\n") || path.includes("\r") || path.includes("\\")) return false;
  if (path !== SANDBOX_WORKSPACE_ROOT && !path.startsWith(`${SANDBOX_WORKSPACE_ROOT}/`)) return false;
  for (const segment of path.split("/")) {
    if (segment === "..") return false;
  }
  return true;
}

/**
 * Turn a Markdown href into an absolute sandbox workspace file path, or null.
 *
 * Marked percent-encodes non-ASCII characters, so decode first; a malformed
 * escape or anything that fails workspace validation returns null.
 */
export function workspaceFilePathFromHref(href: string): string | null {
  if (!href || !href.startsWith("/") || href.startsWith("//")) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(href);
  } catch {
    return null;
  }
  return isWorkspaceFilePath(decoded) ? decoded : null;
}

/** Classify a workspace file path for the UI. */
export function workspaceFileKind(path: string): WorkspaceFileKind {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1) : "";
  return KIND_BY_EXTENSION[ext] ?? "unsupported";
}

/** Human label for a kind, used by cards and the preview header. */
export function kindLabel(kind: WorkspaceFileKind): string {
  switch (kind) {
    case "image":
      return "图片";
    case "pdf":
      return "PDF";
    case "word":
      return "Word 文档";
    case "excel":
      return "Excel 表格";
    case "ppt":
      return "PowerPoint 演示";
    case "text":
      return "文本";
    default:
      return "文件";
  }
}

/** A short badge shown on a file card; kept ASCII so it renders everywhere. */
export function kindBadge(kind: WorkspaceFileKind): string {
  switch (kind) {
    case "image":
      return "IMG";
    case "pdf":
      return "PDF";
    case "word":
      return "DOC";
    case "excel":
      return "XLS";
    case "ppt":
      return "PPT";
    case "text":
      return "TXT";
    default:
      return "FILE";
  }
}

/** True for kinds the sandbox can rasterise into page previews. */
export function isPreviewableKind(kind: WorkspaceFileKind): boolean {
  return kind === "image" || kind === "pdf" || kind === "word" || kind === "excel" || kind === "ppt";
}

/** File name from a workspace path, for display. */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1) || path;
}

/** Markdown shares the safe text transport, but has its own reading presentation. */
export function isMarkdownPath(path: string): boolean {
  return /\.(?:md|markdown)$/i.test(baseName(path));
}

export function isHtmlPath(path: string): boolean { return /\.html?$/i.test(baseName(path)); }
