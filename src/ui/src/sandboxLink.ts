/**
 * Link classification for the chat Markdown view.
 *
 * Two kinds of href are meaningful:
 *
 *  - Absolute http/https URLs open on the device. Only private IP URLs use
 *    the sandbox browser; hostnames are never resolved to classify links.
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
 * classification (`src/control/documents/paths.ts`): the server is authoritative
 * and re-validates, this only decides which control to render.
 *
 * `text` uses the size-capped text endpoint. Markdown gets a sanitized reading
 * view; HTML/code remain escaped source, never active documents. SVG is an image,
 * drawn only by an <img>, where its scripts never run.
 */
export type WorkspaceFileKind = "image" | "video" | "audio" | "pdf" | "word" | "excel" | "ppt" | "text" | "unsupported";

const KIND_BY_EXTENSION: Record<string, WorkspaceFileKind> = {
  mp4: "video", m4v: "video", mov: "video", webm: "video",
  mp3: "audio", m4a: "audio", aac: "audio", wav: "audio", ogg: "audio", oga: "audio", opus: "audio", flac: "audio",
  png: "image", jpg: "image", jpeg: "image", webp: "image", gif: "image", avif: "image", bmp: "image", svg: "image",
  pdf: "pdf",
  doc: "word", docx: "word", odt: "word", rtf: "word",
  xls: "excel", xlsx: "excel", ods: "excel",
  ppt: "ppt", pptx: "ppt", odp: "ppt",
  txt: "text", md: "text", markdown: "text", log: "text", csv: "text", tsv: "text", json: "text",
  yml: "text", yaml: "text", toml: "text", ini: "text", conf: "text", xml: "text",
  html: "text", htm: "text", css: "text",
  js: "text", mjs: "text", cjs: "text", ts: "text", tsx: "text", jsx: "text",
  py: "text", sh: "text", sql: "text", diff: "text", patch: "text",
};

export function isWebLink(href: string): boolean {
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

/** Private IPv4, carrier-grade NAT/Tailscale, loopback and local IPv6. */
export function isSandboxLink(href: string): boolean {
  if (!isWebLink(href)) return false;
  const host = new URL(href).hostname;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 ||
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && b === 168) || (a === 169 && b === 254) ||
      (a === 100 && b! >= 64 && b! <= 127);
  }
  if (!host.startsWith("[")) return false;
  const ip = host.slice(1, -1).toLowerCase();
  if (ip === "::" || ip === "::1" || /^(?:fc|fd)[0-9a-f]{2}:|^fe[89ab][0-9a-f]:/.test(ip)) return true;
  // WHATWG normalizes dotted IPv4-mapped IPv6 into two hexadecimal groups.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
  if (!mapped) return false;
  const first = parseInt(mapped[1]!, 16), last = parseInt(mapped[2]!, 16);
  return isSandboxLink(`http://${first >> 8}.${first & 255}.${last >> 8}.${last & 255}/`);
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
    case "video":
      return "视频";
    case "audio":
      return "音频";
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
    case "video":
      return "VIDEO";
    case "audio":
      return "AUDIO";
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

/** Binary kinds with an inline preview (native media or raster pages). */
export function isPreviewableKind(kind: WorkspaceFileKind): boolean {
  return kind === "video" || kind === "audio" || kind === "image" || kind === "pdf" || kind === "word" || kind === "excel" || kind === "ppt";
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
